"""Celery task that runs ANUGA and publishes each completed frame."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from celery import Celery
from redis import Redis
from sqlalchemy import select

from apps.api.config import Settings
from apps.api.db import Database
from apps.api.models import (
    SimulationArtifact,
    SimulationFrame,
    SimulationJob,
    utcnow,
)
from bayuquan.raster import CogWriter, FrameRasterizer
from bayuquan.raster import RasterInterpolationMapping
from bayuquan.simulation.fixed_model import FixedModelPaths
from bayuquan.simulation.grid_mapping import GridTriangleMapping
from bayuquan.simulation.runner import run_simulation
from bayuquan.simulation.spec import ScenarioSpec

from .storage import ObjectStorage


settings = Settings.from_environment()
celery_app = Celery("bayuquan-worker", broker=settings.celery_broker_url)
celery_app.conf.update(
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
)


class JobRunner:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.database = Database(settings.database_url)
        self.storage = ObjectStorage(settings)
        self.redis = Redis.from_url(settings.redis_url, decode_responses=True)
        self.paths = FixedModelPaths.under(settings.project_root)

    def run(self, job_id: str) -> None:
        with self.database.session_factory.begin() as session:
            job = session.scalar(
                select(SimulationJob)
                .where(SimulationJob.id == job_id)
                .with_for_update()
            )
            if job is None:
                raise ValueError(f"simulation job does not exist: {job_id}")
            if job.status in {"COMPLETED", "FAILED"}:
                return
            if job.status != "QUEUED":
                raise RuntimeError(
                    f"job {job_id} cannot start from {job.status}"
                )
            job.status = "PREPARING"
            job.started_at = utcnow()
            job.error_code = None
            job.error_message = None
            snapshot = job.scenario_snapshot
        self._event(job_id, "job.status", {"status": "PREPARING"})

        try:
            self.storage.ensure_bucket()
            mapping = GridTriangleMapping.load(self.paths.mapping)
            spec = ScenarioSpec.from_dict(snapshot, mapping)
            raster_mapping = RasterInterpolationMapping.load(
                self.paths.raster_mapping,
                mesh_path=self.paths.mesh,
                triangle_count=len(mapping.triangle_cell_index),
            )
            rasterizer = FrameRasterizer(raster_mapping)
            writer = CogWriter(raster_mapping.grid)

            prefix = f"bayuquan-{job_id}-"
            with tempfile.TemporaryDirectory(prefix=prefix) as tmp:
                output = Path(tmp)
                snapshot_path = output / "scenario.json"
                snapshot_path.write_text(
                    json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n"
                )

                def publish_frame(domain, time_seconds, frame_index):
                    frame = rasterizer.rasterize(domain, time_seconds)
                    filename = f"{int(time_seconds):09d}.tif"
                    local = output / "frames" / filename
                    written = writer.write(frame, local)
                    key = f"jobs/{job_id}/frames/{filename}"
                    stored = self.storage.upload_atomic(written.path, key)
                    with self.database.session_factory.begin() as session:
                        exists = session.get(
                            SimulationFrame, (job_id, frame_index)
                        )
                        if exists is not None:
                            raise RuntimeError(
                                f"duplicate frame {frame_index} for {job_id}"
                            )
                        session.add(SimulationFrame(
                            job_id=job_id,
                            frame_index=frame_index,
                            time_seconds=time_seconds,
                            cog_uri=stored.uri,
                            maximum_depth_m=frame.maximum_depth_m,
                            maximum_speed_mps=frame.maximum_speed_mps,
                            wet_area_m2=frame.wet_area_m2,
                        ))
                        active = session.get(SimulationJob, job_id)
                        active.status = "RUNNING"
                        active.current_frame = frame_index
                        active.simulation_time_seconds = time_seconds
                        active.maximum_depth_m = max(
                            active.maximum_depth_m or 0,
                            frame.maximum_depth_m,
                        )
                    self._event(job_id, "frame.ready", {
                        "frameIndex": frame_index,
                        "timeSeconds": time_seconds,
                        "maximumDepthM": frame.maximum_depth_m,
                        "maximumSpeedMps": frame.maximum_speed_mps,
                        "wetAreaM2": frame.wet_area_m2,
                    })

                report = run_simulation(
                    spec,
                    self.paths,
                    output,
                    frame_sink=publish_frame,
                )
                artifacts = [
                    ("SWW", output / "model.sww", "result/model.sww"),
                    ("REPORT", output / "report.json", "result/report.json"),
                    ("SCENARIO_SNAPSHOT", snapshot_path,
                     "input/scenario.json"),
                ]
                stored_artifacts = []
                for artifact_type, path, relative_key in artifacts:
                    stored = self.storage.upload_atomic(
                        path, f"jobs/{job_id}/{relative_key}"
                    )
                    stored_artifacts.append((artifact_type, stored))

            with self.database.session_factory.begin() as session:
                job = session.get(SimulationJob, job_id)
                job.status = "COMPLETED"
                job.completed_at = utcnow()
                job.applied_volume_m3 = report["appliedInputVolumeM3"]
                job.final_water_volume_m3 = report["finalDomainWaterVolumeM3"]
                for artifact_type, stored in stored_artifacts:
                    session.add(SimulationArtifact(
                        job_id=job_id,
                        type=artifact_type,
                        uri=stored.uri,
                        size_bytes=stored.size_bytes,
                        sha256=stored.sha256,
                    ))
            self._event(job_id, "job.completed", report)
        except Exception as error:
            with self.database.session_factory.begin() as session:
                job = session.get(SimulationJob, job_id)
                if job is not None:
                    job.status = "FAILED"
                    job.completed_at = utcnow()
                    job.error_code = "WORKER_FAILED"
                    job.error_message = str(error)[:2000]
            self._event(job_id, "job.failed", {
                "errorCode": "WORKER_FAILED",
                "message": str(error),
            })
            raise

    def _event(self, job_id: str, event: str, payload: dict) -> None:
        self.redis.publish(
            f"jobs:{job_id}",
            json.dumps({"event": event, "data": payload}),
        )


@celery_app.task(name="bayuquan.run_job", bind=True, max_retries=0)
def run_job(_task, job_id: str) -> None:
    JobRunner(settings).run(job_id)
