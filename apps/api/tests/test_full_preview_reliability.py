from __future__ import annotations

import hashlib
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from apps.api.config import Settings
from apps.api.db import Database
from apps.api.models import FullPreviewJob, utcnow
from apps.worker.full_preview_tasks import (
    ExecutionLeaseLost,
    FullPreviewRunner,
    MAX_EXECUTION_ATTEMPTS,
    recover_expired_full_previews,
    run_full_preview,
)


def test_full_preview_task_redelivers_after_worker_loss():
    assert run_full_preview.reject_on_worker_lost is True
    assert run_full_preview.app.conf.task_acks_late is True
    assert run_full_preview.app.conf.worker_prefetch_multiplier == 1


def test_duplicate_delivery_waits_and_stale_attempt_cannot_regress_terminal(
    tmp_path,
):
    database = Database(f"sqlite:///{tmp_path / 'preview.sqlite'}")
    database.create_schema()
    job = _job(status="SOLVING")
    with database.session_factory.begin() as session:
        session.add(job)
    runner = FullPreviewRunner.__new__(FullPreviewRunner)
    runner.database = database

    first_job, first_token = runner._claim(job.id)
    assert first_job.execution_attempt == 1
    assert runner._claim(job.id) is None

    with database.session_factory.begin() as session:
        claimed = session.get(FullPreviewJob, job.id)
        claimed.execution_lease_expires_at = utcnow() - timedelta(seconds=1)
    second_job, second_token = runner._claim(job.id)
    assert second_job.execution_attempt == 2
    assert second_token != first_token
    assert runner._finish(job.id, second_token, {
        "result_cog_uri": "s3://test/result.tif",
    }) is True

    with pytest.raises(ExecutionLeaseLost):
        runner._status(job.id, first_token, "SOLVING")
    assert runner._fail(
        job.id, first_token, RuntimeError("stale failure")
    ) is False
    with database.session_factory() as session:
        completed = session.get(FullPreviewJob, job.id)
        assert completed.status == "COMPLETED"
        assert completed.result_cog_uri == "s3://test/result.tif"
        assert completed.error_code is None


def test_watchdog_requeues_expired_lease_and_bounds_recovery(tmp_path):
    database = Database(f"sqlite:///{tmp_path / 'preview.sqlite'}")
    database.create_schema()
    recoverable = _job(status="PREPARING")
    recoverable.execution_attempt = 1
    recoverable.execution_token = "stale-token"
    recoverable.execution_lease_expires_at = (
        utcnow() - timedelta(seconds=1)
    )
    exhausted = _job(status="PUBLISHING")
    exhausted.execution_attempt = MAX_EXECUTION_ATTEMPTS
    exhausted.execution_token = "exhausted-token"
    exhausted.execution_lease_expires_at = (
        utcnow() - timedelta(seconds=1)
    )
    with database.session_factory.begin() as session:
        session.add_all([recoverable, exhausted])
    dispatched = []

    result = recover_expired_full_previews(
        database,
        lambda job_id, queue: dispatched.append((job_id, queue)),
        queue="full-domain-preview",
    )

    assert result == (1, 1)
    assert dispatched == [(recoverable.id, "full-domain-preview")]
    with database.session_factory() as session:
        waiting = session.get(FullPreviewJob, recoverable.id)
        failed = session.get(FullPreviewJob, exhausted.id)
        assert waiting.status == "PREPARING"
        assert waiting.execution_token is None
        assert failed.status == "FAILED"
        assert failed.error_code == "FULL_PREVIEW_RECOVERY_EXHAUSTED"


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
    job = _job(status=interrupted_phase)
    job.cache_identity_hash = hashlib.sha256(identity.encode()).hexdigest()
    with database.session_factory.begin() as session:
        session.add(job)
    _run_recovery(
        tmp_path, monkeypatch, database, dem, cache, job, identity
    )


def _job(*, status: str) -> FullPreviewJob:
    return FullPreviewJob(
        dem_product_id="dem-test",
        domain_id="regional-v1",
        dataset_version="dataset-v1",
        assumptions_profile_id="terrain-storage-v1",
        runoff_coefficient=0.65,
        cache_identity_hash="a" * 64,
        compatibility_version="c" * 64,
        rainfall_depth_mm=80,
        effective_rainfall_depth_mm=52,
        status=status,
        phase=status,
    )


def _run_recovery(
    tmp_path, monkeypatch, database, dem, cache, job, identity,
):
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
