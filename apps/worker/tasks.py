"""Celery task that runs ANUGA and publishes each completed frame."""

from __future__ import annotations

import json
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from celery import Celery
from celery.utils.log import get_task_logger
from redis import Redis
from sqlalchemy import select

from apps.api.config import Settings
from apps.api.db import Database
from apps.api.dem_products import DemProductCatalog
from apps.api.models import (
    SimulationArtifact,
    SimulationFrame,
    SimulationJob,
    utcnow,
)
from bayuquan.raster import CogWriter, LocalFrameRasterizer, RasterFrame
from bayuquan.simulation.local_runner import run_local_simulation
from bayuquan.simulation.spec import ScenarioSpec
from bayuquan.simulation.timing import PhaseTimings

from .frame_pipeline import OrderedBoundedPipeline
from .storage import ObjectStorage

settings = Settings.from_environment()
celery_app = Celery("bayuquan-worker", broker=settings.celery_broker_url)
logger = get_task_logger(__name__)
celery_app.conf.update(
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
)


@dataclass(frozen=True)
class FramePublication:
    frame: RasterFrame
    time_seconds: float
    frame_index: int
    filename: str


def artifact_manifest(
    output: Path,
    snapshot_path: Path,
    *,
    write_sww: bool,
) -> list[tuple[str, Path, str]]:
    artifacts = [
        ("SCENARIO_SNAPSHOT", snapshot_path, "input/scenario.json"),
    ]
    if write_sww:
        artifacts.insert(0, ("SWW", output / "model.sww", "result/model.sww"))
    return artifacts


class JobRunner:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.database = Database(settings.database_url)
        self.storage = ObjectStorage(settings)
        self.redis = Redis.from_url(settings.redis_url, decode_responses=True)
        self.dem_products = DemProductCatalog(
            self.database,
            settings.simulation_area_cache
            or (settings.project_root / "simulation_areas"),
        )

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
                raise RuntimeError(f"job {job_id} cannot start from {job.status}")
            job.status = "PREPARING"
            job.started_at = utcnow()
            job.error_code = None
            job.error_message = None
            snapshot = job.scenario_snapshot
            product_id = job.dem_product_id
        self._event(job_id, "job.status", {"status": "PREPARING"})

        try:
            self.storage.ensure_bucket()
            area_hash = snapshot["simulationAreaId"]
            product = self.dem_products.get(product_id)
            area_catalog = self.dem_products.area_catalog(product_id)
            area = area_catalog.area(area_hash)
            mapping = area_catalog.mapping(area_hash)
            spec = ScenarioSpec.from_dict(snapshot, mapping)
            prefix = f"bayuquan-{job_id}-"
            with tempfile.TemporaryDirectory(prefix=prefix) as tmp:
                output = Path(tmp)
                rasterizer = None
                writer = None
                pipeline = None
                publication_timings = PhaseTimings()
                snapshot_path = output / "scenario.json"
                snapshot_path.write_text(
                    json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n"
                )

                def consume_frame(publication: FramePublication) -> None:
                    if writer is None:
                        raise RuntimeError("frame writer was not prepared")
                    local_path = output / "frames" / publication.filename
                    with publication_timings.measure("cogWrite"):
                        written = writer.write(publication.frame, local_path)
                    key = f"jobs/{job_id}/frames/{publication.filename}"
                    with publication_timings.measure("frameObjectStore"):
                        stored = self.storage.upload_atomic(written.path, key)
                    written.path.unlink()
                    with (
                        publication_timings.measure("frameDatabase"),
                        self.database.session_factory.begin() as session,
                    ):
                        exists = session.get(
                            SimulationFrame,
                            (job_id, publication.frame_index),
                        )
                        if exists is not None:
                            raise RuntimeError(
                                "duplicate frame "
                                f"{publication.frame_index} for {job_id}"
                            )
                        session.add(
                            SimulationFrame(
                                job_id=job_id,
                                frame_index=publication.frame_index,
                                time_seconds=publication.time_seconds,
                                cog_uri=stored.uri,
                                maximum_depth_m=(publication.frame.maximum_depth_m),
                                maximum_speed_mps=(publication.frame.maximum_speed_mps),
                                wet_area_m2=publication.frame.wet_area_m2,
                            )
                        )
                        active = session.get(SimulationJob, job_id)
                        active.status = "RUNNING"
                        active.current_frame = publication.frame_index
                        active.simulation_time_seconds = publication.time_seconds
                        active.maximum_depth_m = max(
                            active.maximum_depth_m or 0,
                            publication.frame.maximum_depth_m,
                        )
                    with publication_timings.measure("frameEvent"):
                        self._event(
                            job_id,
                            "frame.ready",
                            {
                                "frameIndex": publication.frame_index,
                                "timeSeconds": publication.time_seconds,
                                "maximumDepthM": (publication.frame.maximum_depth_m),
                                "maximumSpeedMps": (
                                    publication.frame.maximum_speed_mps
                                ),
                                "wetAreaM2": publication.frame.wet_area_m2,
                            },
                        )

                def accept_prepared(local):
                    nonlocal rasterizer, writer, pipeline
                    logger.info(
                        "job %s prepared %d triangles with %d OpenMP threads",
                        job_id,
                        len(local.prepared.domain.areas),
                        local.prepared.domain.omp_num_threads,
                    )
                    rasterizer = LocalFrameRasterizer(
                        area,
                        local.triangle_cell_index,
                        np.asarray(local.prepared.domain.areas, dtype=float),
                    )
                    writer = CogWriter(rasterizer.grid)
                    pipeline = OrderedBoundedPipeline(
                        consume_frame,
                        max_pending=2,
                        thread_name_prefix=f"frame-{job_id}",
                    )

                def publish_frame(domain, time_seconds, frame_index):
                    if rasterizer is None or pipeline is None:
                        raise RuntimeError("frame publisher was not prepared")
                    with publication_timings.measure("frameRasterize"):
                        # RasterFrame owns fresh NumPy arrays and is safe to
                        # consume after ANUGA advances the mutable Domain.
                        frame = rasterizer.rasterize(domain, time_seconds)
                    publication = FramePublication(
                        frame=frame,
                        time_seconds=float(time_seconds),
                        frame_index=frame_index,
                        filename=f"{int(time_seconds):09d}.tif",
                    )
                    with publication_timings.measure("frameQueueWait"):
                        pipeline.submit(publication)

                simulation_started = time.monotonic()
                try:
                    report = run_local_simulation(
                        spec,
                        area_hash,
                        area_catalog,
                        product.compute_model_inputs_uri,
                        output,
                        frame_sink=publish_frame,
                        prepared_sink=accept_prepared,
                        write_sww=self.settings.write_sww,
                    )
                except Exception:
                    if pipeline is not None:
                        pipeline.abort()
                    raise
                if pipeline is None:
                    raise RuntimeError("frame pipeline was not prepared")
                with publication_timings.measure("pipelineDrain"):
                    pipeline.close()

                report["runtimeSeconds"] = time.monotonic() - simulation_started
                report_timings = report.setdefault("timingsSeconds", {})
                report_timings.update(publication_timings.snapshot())
                report_path = output / "report.json"
                report_path.write_text(
                    json.dumps(report, ensure_ascii=False, indent=2) + "\n"
                )

                artifacts = artifact_manifest(
                    output,
                    snapshot_path,
                    write_sww=self.settings.write_sww,
                )
                stored_artifacts = []
                artifact_store_started = time.perf_counter()
                for artifact_type, path, relative_key in artifacts:
                    stored = self.storage.upload_atomic(
                        path, f"jobs/{job_id}/{relative_key}"
                    )
                    stored_artifacts.append((artifact_type, stored))
                report_timings["artifactObjectStore"] = round(
                    time.perf_counter() - artifact_store_started, 6
                )
                report["runtimeSeconds"] = time.monotonic() - simulation_started
                report_path.write_text(
                    json.dumps(report, ensure_ascii=False, indent=2) + "\n"
                )
                stored = self.storage.upload_atomic(
                    report_path, f"jobs/{job_id}/result/report.json"
                )
                stored_artifacts.append(("REPORT", stored))

            with self.database.session_factory.begin() as session:
                job = session.get(SimulationJob, job_id)
                job.status = "COMPLETED"
                job.completed_at = utcnow()
                job.applied_volume_m3 = report["appliedInputVolumeM3"]
                job.final_water_volume_m3 = report["finalDomainWaterVolumeM3"]
                for artifact_type, stored in stored_artifacts:
                    session.add(
                        SimulationArtifact(
                            job_id=job_id,
                            type=artifact_type,
                            uri=stored.uri,
                            size_bytes=stored.size_bytes,
                            sha256=stored.sha256,
                        )
                    )
            self._event(job_id, "job.completed", report)
        except Exception as error:
            with self.database.session_factory.begin() as session:
                job = session.get(SimulationJob, job_id)
                if job is not None:
                    job.status = "FAILED"
                    job.completed_at = utcnow()
                    job.error_code = "WORKER_FAILED"
                    job.error_message = str(error)[:2000]
            self._event(
                job_id,
                "job.failed",
                {
                    "errorCode": "WORKER_FAILED",
                    "message": str(error),
                },
            )
            raise

    def _event(self, job_id: str, event: str, payload: dict) -> None:
        self.redis.publish(
            f"jobs:{job_id}",
            json.dumps({"event": event, "data": payload}),
        )


@celery_app.task(name="bayuquan.run_job", bind=True, max_retries=0)
def run_job(_task, job_id: str) -> None:
    JobRunner(settings).run(job_id)


# Register the independent regional preview task on this Celery application.
from . import full_preview_tasks as _full_preview_tasks  # noqa: E402,F401
