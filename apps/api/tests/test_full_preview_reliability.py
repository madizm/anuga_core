from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from apps.api.config import Settings
from apps.api.db import Database
from apps.api.models import FullPreviewJob
from apps.worker.full_preview_tasks import FullPreviewRunner, run_full_preview


def test_full_preview_task_redelivers_after_worker_loss():
    assert run_full_preview.reject_on_worker_lost is True
    assert run_full_preview.app.conf.task_acks_late is True
    assert run_full_preview.app.conf.worker_prefetch_multiplier == 1


@pytest.mark.parametrize("interrupted_phase", [
    "PREPARING", "SOLVING", "PUBLISHING",
])
def test_full_preview_runner_reclaims_active_phase_when_redis_is_down(
    tmp_path, monkeypatch, interrupted_phase
):
    database = Database(f"sqlite:///{tmp_path / 'preview.sqlite'}")
    database.create_schema()
    dem = tmp_path / "dem.tif"
    cache = tmp_path / "cache.npz"
    cache.write_bytes(b"prepared")
    with rasterio.open(
        dem,
        "w",
        driver="GTiff",
        width=2,
        height=1,
        count=1,
        dtype="float32",
        crs="EPSG:32651",
        transform=from_origin(430_000, 4_462_000, 5, 5),
    ) as dataset:
        dataset.write(np.ones((1, 1, 2), dtype=np.float32))

    identity = "cache-identity"
    job = FullPreviewJob(
        dem_product_id="dem-test",
        domain_id="regional-v1",
        dataset_version="dataset-v1",
        assumptions_profile_id="terrain-storage-v1",
        runoff_coefficient=0.65,
        cache_identity_hash=hashlib.sha256(identity.encode()).hexdigest(),
        compatibility_version="c" * 64,
        rainfall_depth_mm=80,
        effective_rainfall_depth_mm=52,
        status=interrupted_phase,
        phase=interrupted_phase,
    )
    with database.session_factory.begin() as session:
        session.add(job)
    settings = _settings(database, tmp_path, cache)
    result = SimpleNamespace(
        input_volume_m3=100.0,
        retained_volume_m3=80.0,
        outflow_volume_m3=20.0,
        mass_balance_error_m3=0.0,
    )
    preprocessed = SimpleNamespace(
        basin_ids=np.full((1, 2), -1, dtype=np.int32),
        network=SimpleNamespace(solve=lambda **kwargs: result),
    )
    written = SimpleNamespace(
        maximum_depth_m=0.4,
        wet_area_m2=25.0,
        threshold_areas_m2={0.05: 25.0},
    )
    uploaded_keys = []
    runner = FullPreviewRunner.__new__(FullPreviewRunner)
    runner.settings = settings
    runner.database = database
    runner.products = SimpleNamespace(get=lambda product_id: SimpleNamespace(
        compute_dem_uri=str(dem), dataset_version="dataset-v1"
    ))
    runner.storage = SimpleNamespace(
        ensure_bucket=lambda: None,
        upload_atomic=lambda source, key: (
            uploaded_keys.append(key)
            or SimpleNamespace(uri=f"s3://test/{key}")
        ),
    )
    runner.redis = SimpleNamespace(
        publish=lambda *args, **kwargs: (_ for _ in ()).throw(
            ConnectionError("redis unavailable")
        )
    )
    monkeypatch.setattr(
        "apps.worker.full_preview_tasks.cache_identity",
        lambda **kwargs: identity,
    )
    monkeypatch.setattr(
        "apps.worker.full_preview_tasks.load_preprocessed",
        lambda *args, **kwargs: preprocessed,
    )
    monkeypatch.setattr(
        "apps.worker.full_preview_tasks.write_maximum_depth_cog",
        lambda **kwargs: written,
    )
    monkeypatch.setattr(
        "apps.worker.full_preview_tasks._geographic_bounds",
        lambda *args: [122.0, 40.0, 123.0, 41.0],
    )

    runner.run(job.id)

    with database.session_factory() as session:
        recovered = session.get(FullPreviewJob, job.id)
        assert recovered.status == "COMPLETED"
        assert recovered.error_code is None
        assert recovered.result_cog_uri.endswith("maximum-depth.cog.tif")
    assert uploaded_keys == [
        f"full-previews/{job.id}/maximum-depth.cog.tif",
        f"full-previews/{job.id}/report.json",
    ]


def _settings(database: Database, root: Path, cache: Path) -> Settings:
    return Settings(
        project_root=root,
        database_url=str(database.engine.url),
        redis_url="redis://unused",
        celery_broker_url="redis://unused",
        s3_endpoint_url="http://unused",
        s3_access_key="test",
        s3_secret_key="test",
        s3_bucket="test",
        titiler_url="http://unused",
        dispatch_jobs=False,
        auto_create_schema=False,
        full_preview_dem_product_id="dem-test",
        full_preview_cache=cache,
        full_preview_window=(0, 0, 2, 1),
    )
