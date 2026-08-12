"""Celery runtime for regional non-authoritative fill-spill previews."""

from __future__ import annotations

import hashlib
import json
import tempfile
import uuid
from datetime import timedelta
from pathlib import Path

import rasterio
from celery.utils.log import get_task_logger
from pyproj import Transformer
from rasterio.windows import Window
from redis import Redis
from sqlalchemy import func, or_, select, update

from apps.api.config import Settings
from apps.api.db import Database
from apps.api.dem_products import DemProductCatalog
from apps.api.models import FullPreviewJob, utcnow
from bayuquan.preview.cache import cache_identity, load_preprocessed
from bayuquan.preview.depth_cog import write_maximum_depth_cog

from .storage import ObjectStorage
from .tasks import celery_app

logger = get_task_logger(__name__)
EXECUTION_LEASE = timedelta(hours=6)
ACTIVE_STATUSES = ("QUEUED", "PREPARING", "SOLVING", "PUBLISHING")
RECOVERABLE_STATUSES = ("PREPARING", "SOLVING", "PUBLISHING")
MAX_EXECUTION_ATTEMPTS = 3


class ExecutionLeaseLost(RuntimeError):
    pass


class FullPreviewRunner:
    """Run one rainfall volume against an administrator-prepared hierarchy."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.database = Database(settings.database_url)
        self.storage = ObjectStorage(settings)
        self.redis = Redis.from_url(settings.redis_url, decode_responses=True)
        self.products = DemProductCatalog(
            self.database,
            settings.simulation_area_cache
            or (settings.project_root / "simulation_areas"),
        )

    def run(self, job_id: str) -> None:
        claimed = self._claim(job_id)
        if claimed is None:
            return
        job, execution_token = claimed
        rainfall_depth_m = job.effective_rainfall_depth_mm / 1000.0
        product_id = job.dem_product_id
        self._event(job_id, "preview.status", {"status": "PREPARING"})

        try:
            cache_path = self.settings.full_preview_cache
            raw_window = self.settings.full_preview_window
            if cache_path is None or not cache_path.is_file():
                raise RuntimeError("full preview preprocessing cache is missing")
            if raw_window is None:
                raise RuntimeError("full preview domain window is missing")
            product = self.products.get(product_id)
            dem_path = Path(product.compute_dem_uri)
            window = Window(*raw_window)
            with rasterio.open(dem_path) as source:
                transform = source.window_transform(window)
                identity = cache_identity(
                    dem_path=dem_path,
                    window=raw_window,
                    transform=tuple(transform),
                )
            identity_hash = hashlib.sha256(identity.encode()).hexdigest()
            if product.dataset_version != job.dataset_version:
                raise RuntimeError(
                    "full preview DEM dataset version changed after submission"
                )
            if identity_hash != job.cache_identity_hash:
                raise RuntimeError(
                    "full preview cache identity changed after submission"
                )
            preprocessed = load_preprocessed(
                cache_path,
                expected_identity=identity,
            )
            if preprocessed.basin_ids.shape != (
                int(window.height), int(window.width)
            ):
                raise RuntimeError(
                    "full preview basin shape does not match domain window"
                )
            self._status(
                job_id, execution_token, "SOLVING", cache_hit=True
            )
            result = preprocessed.network.solve(
                effective_rainfall_depth_m=rainfall_depth_m,
            )

            self._status(
                job_id, execution_token, "PUBLISHING", cache_hit=True
            )
            self.storage.ensure_bucket()
            with tempfile.TemporaryDirectory(
                prefix=f"bayuquan-full-preview-{job_id}-"
            ) as directory:
                output = Path(directory)
                cog_path = output / "maximum-depth.cog.tif"
                written = write_maximum_depth_cog(
                    dem_path=dem_path,
                    source_window=window,
                    basin_ids=preprocessed.basin_ids,
                    result=result,
                    destination=cog_path,
                )
                bounds = _geographic_bounds(dem_path, window)
                report = {
                    "authority": "non-authoritative",
                    "effectiveRainfallDepthMm": rainfall_depth_m * 1000.0,
                    "effectiveRainfallDepthM": rainfall_depth_m,
                    "maximumDepthM": written.maximum_depth_m,
                    "wetAreaM2": written.wet_area_m2,
                    "thresholdAreasM2": {
                        f"{threshold:.2f}": area
                        for threshold, area in (
                            written.threshold_areas_m2.items()
                        )
                    },
                    "inputVolumeM3": result.input_volume_m3,
                    "retainedVolumeM3": result.retained_volume_m3,
                    "outflowVolumeM3": result.outflow_volume_m3,
                    "massBalanceErrorM3": result.mass_balance_error_m3,
                    "bounds": bounds,
                }
                report_path = output / "report.json"
                report_path.write_text(
                    json.dumps(report, ensure_ascii=False, indent=2) + "\n"
                )
                cog = self.storage.upload_atomic(
                    cog_path,
                    f"full-previews/{job_id}/maximum-depth.cog.tif",
                )
                report_object = self.storage.upload_atomic(
                    report_path,
                    f"full-previews/{job_id}/report.json",
                )

            completed = self._finish(job_id, execution_token, {
                "cache_hit": True,
                "result_cog_uri": cog.uri,
                "report_uri": report_object.uri,
                "bounds": bounds,
                "maximum_depth_m": written.maximum_depth_m,
                "wet_area_m2": written.wet_area_m2,
                "threshold_areas_m2": report["thresholdAreasM2"],
                "input_volume_m3": result.input_volume_m3,
                "retained_volume_m3": result.retained_volume_m3,
                "outflow_volume_m3": result.outflow_volume_m3,
                "mass_balance_error_m3": result.mass_balance_error_m3,
            })
            if completed:
                self._event(job_id, "preview.completed", report)
        except ExecutionLeaseLost:
            logger.info("full preview %s execution lease was replaced", job_id)
            return
        except Exception as error:
            logger.exception("full preview %s failed", job_id)
            if self._fail(job_id, execution_token, error):
                self._event(job_id, "preview.failed", {
                    "errorCode": "FULL_PREVIEW_FAILED",
                    "message": str(error),
                })
            raise

    def _claim(self, job_id: str):
        now = utcnow()
        token = str(uuid.uuid4())
        with self.database.session_factory.begin() as session:
            result = session.execute(
                update(FullPreviewJob)
                .where(
                    FullPreviewJob.id == job_id,
                    FullPreviewJob.status.in_(ACTIVE_STATUSES),
                    or_(
                        FullPreviewJob.execution_token.is_(None),
                        FullPreviewJob.execution_lease_expires_at.is_(None),
                        FullPreviewJob.execution_lease_expires_at <= now,
                    ),
                )
                .values(
                    status="PREPARING",
                    phase="PREPARING",
                    started_at=func.coalesce(
                        FullPreviewJob.started_at, now
                    ),
                    completed_at=None,
                    error_code=None,
                    error_message=None,
                    execution_attempt=FullPreviewJob.execution_attempt + 1,
                    execution_token=token,
                    execution_lease_expires_at=now + EXECUTION_LEASE,
                )
            )
            if result.rowcount == 0:
                if session.get(FullPreviewJob, job_id) is None:
                    raise ValueError(
                        f"full preview does not exist: {job_id}"
                    )
                return None
            job = session.get(FullPreviewJob, job_id)
            return job, token

    def _status(
        self, job_id: str, token: str, phase: str,
        *, cache_hit: bool | None = None
    ) -> None:
        values = {
            "status": phase,
            "phase": phase,
            "execution_lease_expires_at": utcnow() + EXECUTION_LEASE,
        }
        if cache_hit is not None:
            values["cache_hit"] = cache_hit
        with self.database.session_factory.begin() as session:
            result = session.execute(
                update(FullPreviewJob)
                .where(
                    FullPreviewJob.id == job_id,
                    FullPreviewJob.execution_token == token,
                    FullPreviewJob.status.in_(ACTIVE_STATUSES),
                )
                .values(**values)
            )
            if result.rowcount != 1:
                raise ExecutionLeaseLost(job_id)
        self._event(job_id, "preview.status", {
            "status": phase,
            "cacheHit": cache_hit,
        })

    def _finish(self, job_id: str, token: str, values: dict) -> bool:
        with self.database.session_factory.begin() as session:
            result = session.execute(
                update(FullPreviewJob)
                .where(
                    FullPreviewJob.id == job_id,
                    FullPreviewJob.execution_token == token,
                    FullPreviewJob.status.in_(ACTIVE_STATUSES),
                )
                .values(
                    **values,
                    status="COMPLETED",
                    phase="COMPLETED",
                    completed_at=utcnow(),
                    execution_token=None,
                    execution_lease_expires_at=None,
                )
            )
            return result.rowcount == 1

    def _fail(self, job_id: str, token: str, error: Exception) -> bool:
        with self.database.session_factory.begin() as session:
            result = session.execute(
                update(FullPreviewJob)
                .where(
                    FullPreviewJob.id == job_id,
                    FullPreviewJob.execution_token == token,
                    FullPreviewJob.status.in_(ACTIVE_STATUSES),
                )
                .values(
                    status="FAILED",
                    phase="FAILED",
                    completed_at=utcnow(),
                    error_code="FULL_PREVIEW_FAILED",
                    error_message=str(error)[:2000],
                    execution_token=None,
                    execution_lease_expires_at=None,
                )
            )
            return result.rowcount == 1

    def _event(self, job_id: str, event: str, payload: dict) -> None:
        try:
            self.redis.publish(
                f"full-previews:{job_id}",
                json.dumps({"event": event, "data": payload}),
            )
        except Exception:
            logger.warning(
                "could not publish full preview event for %s", job_id,
                exc_info=True,
            )


def _geographic_bounds(
    dem_path: Path, window: Window
) -> list[float]:
    with rasterio.open(dem_path) as source:
        bounds = rasterio.windows.bounds(window, source.transform)
        transformer = Transformer.from_crs(
            source.crs, "OGC:CRS84", always_xy=True
        )
        west, south = transformer.transform(bounds[0], bounds[1])
        east, north = transformer.transform(bounds[2], bounds[3])
    return [west, south, east, north]


def recover_expired_full_previews(
    database: Database,
    dispatch,
    *,
    queue: str,
) -> tuple[int, int]:
    now = utcnow()
    requeue_ids = []
    failed = 0
    with database.session_factory.begin() as session:
        jobs = session.scalars(
            select(FullPreviewJob)
            .where(
                FullPreviewJob.status.in_(RECOVERABLE_STATUSES),
                or_(
                    FullPreviewJob.execution_token.is_(None),
                    FullPreviewJob.execution_lease_expires_at.is_(None),
                    FullPreviewJob.execution_lease_expires_at <= now,
                ),
            )
            .with_for_update(skip_locked=True)
        ).all()
        for job in jobs:
            job.execution_token = None
            job.execution_lease_expires_at = None
            if job.execution_attempt >= MAX_EXECUTION_ATTEMPTS:
                job.status = "FAILED"
                job.phase = "FAILED"
                job.completed_at = now
                job.error_code = "FULL_PREVIEW_RECOVERY_EXHAUSTED"
                job.error_message = (
                    "full preview worker recovery attempts exhausted"
                )
                failed += 1
            else:
                requeue_ids.append(job.id)
    for job_id in requeue_ids:
        try:
            dispatch(job_id, queue)
        except Exception:
            logger.exception(
                "could not requeue expired full preview %s", job_id
            )
    return len(requeue_ids), failed


@celery_app.task(
    name="bayuquan.run_full_preview",
    bind=True,
    max_retries=0,
    reject_on_worker_lost=True,
)
def run_full_preview(_task, job_id: str) -> None:
    FullPreviewRunner(Settings.from_environment()).run(job_id)


@celery_app.task(name="bayuquan.recover_full_previews")
def recover_full_previews() -> tuple[int, int]:
    settings = Settings.from_environment()
    database = Database(settings.database_url)

    def dispatch(job_id: str, queue: str) -> None:
        celery_app.send_task(
            "bayuquan.run_full_preview", args=[job_id], queue=queue
        )

    return recover_expired_full_previews(
        database, dispatch, queue=settings.full_preview_queue
    )
