"""Environment-backed API configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    project_root: Path
    database_url: str
    redis_url: str
    celery_broker_url: str
    s3_endpoint_url: str
    s3_access_key: str
    s3_secret_key: str
    s3_bucket: str
    titiler_url: str
    dispatch_jobs: bool
    auto_create_schema: bool
    dem_product_manifest: Path | None = None
    simulation_area_cache: Path | None = None

    @classmethod
    def from_environment(cls) -> "Settings":
        root = Path(os.getenv("BAYUQUAN_PROJECT_ROOT", "/workspace"))
        redis_url = os.getenv("REDIS_URL", "redis://redis:6379/0")
        return cls(
            project_root=root,
            database_url=os.getenv(
                "DATABASE_URL",
                "postgresql+psycopg://anuga:anuga@postgres:5432/anuga",
            ),
            redis_url=redis_url,
            celery_broker_url=os.getenv("CELERY_BROKER_URL", redis_url),
            s3_endpoint_url=os.getenv("S3_ENDPOINT_URL", "http://minio:9000"),
            s3_access_key=os.getenv("S3_ACCESS_KEY", "anuga"),
            s3_secret_key=os.getenv("S3_SECRET_KEY", "anuga-secret"),
            s3_bucket=os.getenv("S3_BUCKET", "simulation-jobs"),
            titiler_url=os.getenv("TITILER_URL", "http://titiler:8000"),
            dispatch_jobs=os.getenv("DISPATCH_JOBS", "true").lower()
            in {"1", "true", "yes"},
            auto_create_schema=os.getenv(
                "AUTO_CREATE_SCHEMA", "false"
            ).lower() in {"1", "true", "yes"},
            dem_product_manifest=Path(os.getenv(
                "DEM_PRODUCT_MANIFEST",
                str(root / "OUTPUT/model/dem-products.json"),
            )),
            simulation_area_cache=Path(os.getenv(
                "SIMULATION_AREA_CACHE",
                str(root / "simulation_areas"),
            )),
        )
