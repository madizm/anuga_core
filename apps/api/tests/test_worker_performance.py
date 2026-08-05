from __future__ import annotations

import hashlib

import pytest

from apps.api.config import Settings
from apps.worker.frame_pipeline import OrderedBoundedPipeline
from apps.worker.storage import ObjectStorage
from apps.worker.tasks import artifact_manifest


def test_ordered_pipeline_preserves_order_and_propagates_failures():
    consumed = []
    pipeline = OrderedBoundedPipeline(consumed.append, max_pending=2)

    for value in range(5):
        pipeline.submit(value)
    pipeline.close()

    assert consumed == [0, 1, 2, 3, 4]

    def fail(value):
        raise RuntimeError(f"cannot publish {value}")

    broken = OrderedBoundedPipeline(fail, max_pending=1)
    broken.submit(7)
    with pytest.raises(RuntimeError, match="cannot publish 7"):
        broken.close()


def test_object_storage_uploads_final_key_without_copy_or_delete(tmp_path):
    source = tmp_path / "frame.tif"
    source.write_bytes(b"immutable-frame")

    class Client:
        def __init__(self):
            self.calls = []

        def upload_file(self, path, bucket, key):
            self.calls.append((path, bucket, key))

    storage = object.__new__(ObjectStorage)
    storage.bucket = "results"
    storage.client = Client()

    stored = storage.upload_atomic(source, "jobs/job-1/frames/0.tif")

    assert storage.client.calls == [(str(source), "results", "jobs/job-1/frames/0.tif")]
    assert stored.sha256 == hashlib.sha256(b"immutable-frame").hexdigest()
    assert stored.size_bytes == len(b"immutable-frame")


def test_settings_can_disable_sww(monkeypatch):
    monkeypatch.setenv("BAYUQUAN_WRITE_SWW", "false")

    configured = Settings.from_environment()

    assert configured.write_sww is False


def test_artifact_manifest_omits_sww_when_disabled(tmp_path):
    snapshot = tmp_path / "scenario.json"

    without_sww = artifact_manifest(tmp_path, snapshot, write_sww=False)
    with_sww = artifact_manifest(tmp_path, snapshot, write_sww=True)

    assert [item[0] for item in without_sww] == ["SCENARIO_SNAPSHOT"]
    assert [item[0] for item in with_sww] == [
        "SWW",
        "SCENARIO_SNAPSHOT",
    ]
