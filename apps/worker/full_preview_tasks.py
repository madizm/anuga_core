"""Celery runtime for regional non-authoritative fill-spill previews."""

from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path

import rasterio
from celery.utils.log import get_task_logger
from pyproj import Transformer
from rasterio.windows import Window
from redis import Redis
from sqlalchemy import select

from apps.api.config import Settings
from apps.api.db import Database
from apps.api.dem_products import DemProductCatalog
from apps.api.models import FullPreviewJob, utcnow
from bayuquan.preview.cache import cache_identity, load_preprocessed
from bayuquan.preview.depth_cog import write_maximum_depth_cog

from .storage import ObjectStorage
from .tasks import celery_app

logger = get_task_logger(__name__)


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
        with self.database.session_factory.begin() as session:
            job = session.scalar(
                select(FullPreviewJob)
                .where(FullPreviewJob.id == job_id)
                .with_for_update()
            )
            if job is None:
                raise ValueError(f"full preview does not exist: {job_id}")
            if job.status in {"COMPLETED", "FAILED"}:
                return
            if job.status not in {
                "QUEUED", "PREPARING", "SOLVING", "PUBLISHING",
            }:
                raise RuntimeError(
                    f"full preview {job_id} cannot start from {job.status}"
                )
            job.status = "PREPARING"
            job.phase = "PREPARING"
            job.started_at = job.started_at or utcnow()
            job.completed_at = None
            job.error_code = None
            job.error_message = None
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
            self._status(job_id, "SOLVING", cache_hit=True)
            result = preprocessed.network.solve(
                effective_rainfall_depth_m=rainfall_depth_m,
            )

            self._status(job_id, "PUBLISHING", cache_hit=True)
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

            with self.database.session_factory.begin() as session:
                job = session.get(FullPreviewJob, job_id)
                job.status = "COMPLETED"
                job.phase = "COMPLETED"
                job.completed_at = utcnow()
                job.cache_hit = True
                job.result_cog_uri = cog.uri
                job.report_uri = report_object.uri
                job.bounds = bounds
                job.maximum_depth_m = written.maximum_depth_m
                job.wet_area_m2 = written.wet_area_m2
                job.threshold_areas_m2 = report["thresholdAreasM2"]
                job.input_volume_m3 = result.input_volume_m3
                job.retained_volume_m3 = result.retained_volume_m3
                job.outflow_volume_m3 = result.outflow_volume_m3
                job.mass_balance_error_m3 = result.mass_balance_error_m3
            self._event(job_id, "preview.completed", report)
        except Exception as error:
            logger.exception("full preview %s failed", job_id)
            with self.database.session_factory.begin() as session:
                job = session.get(FullPreviewJob, job_id)
                if job is not None:
                    job.status = "FAILED"
                    job.phase = "FAILED"
                    job.completed_at = utcnow()
                    job.error_code = "FULL_PREVIEW_FAILED"
                    job.error_message = str(error)[:2000]
            self._event(job_id, "preview.failed", {
                "errorCode": "FULL_PREVIEW_FAILED",
                "message": str(error),
            })
            raise

    def _status(
        self, job_id: str, phase: str, *, cache_hit: bool | None = None
    ) -> None:
        with self.database.session_factory.begin() as session:
            job = session.get(FullPreviewJob, job_id)
            job.status = phase
            job.phase = phase
            if cache_hit is not None:
                job.cache_hit = cache_hit
        self._event(job_id, "preview.status", {
            "status": phase,
            "cacheHit": cache_hit,
        })

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


@celery_app.task(
    name="bayuquan.run_full_preview", bind=True, max_retries=0
)
def run_full_preview(_task, job_id: str) -> None:
    FullPreviewRunner(Settings.from_environment()).run(job_id)
