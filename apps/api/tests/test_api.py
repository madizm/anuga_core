from __future__ import annotations

from types import SimpleNamespace

from pathlib import Path
from io import BytesIO

from PIL import Image
from rasterio.io import MemoryFile
from rasterio.transform import from_origin

import numpy as np
from fastapi.testclient import TestClient

from apps.api.config import Settings
from apps.api.db import Database
from apps.api.main import _apply_depth_mask, create_app
from apps.api.models import SimulationFrame, SimulationJob
from bayuquan.simulation.grid_mapping import GridTriangleMapping


class FakeCatalog:
    version_id = "abcd1234"
    grid_geojson = {"type": "FeatureCollection", "features": []}

    def __init__(self):
        self.mapping = GridTriangleMapping(
            triangle_cell_index=np.arange(6, dtype=np.int32),
            triangle_area_m2=np.full(6, 450.0),
            nrows=2,
            ncols=3,
            cellsize=30,
            xllcorner=100,
            yllcorner=200,
            mesh_sha256="a" * 64,
        )
        self.cells = {
            f"r{row:04d}-c{column:04d}": {
                "cell_id": f"r{row:04d}-c{column:04d}",
                "elevation_m": "5",
                "building_fraction": "0.1",
                "manning_low": "0.03",
                "manning_middle": "0.05",
                "manning_high": "0.08",
            }
            for row in range(2)
            for column in range(3)
        }

    def metadata(self):
        return {
            "version": self.version_id,
            "crs": "EPSG:32651",
            "gridRows": 2,
            "gridColumns": 3,
            "cellSizeM": 30,
            "selectableCellCount": 6,
            "gridUrl": "/api/model/grid",
            "boundaryCondition": "transmissive",
            "meshSha256": self.mapping.mesh_sha256,
        }

    def cell(self, cell_id):
        return self.cells.get(cell_id)


def settings(database_url: str) -> Settings:
    return Settings(
        project_root=Path("."),
        database_url=database_url,
        redis_url="redis://unused",
        celery_broker_url="redis://unused",
        s3_endpoint_url="http://unused",
        s3_access_key="test",
        s3_secret_key="test",
        s3_bucket="test",
        titiler_url="http://unused",
        dispatch_jobs=False,
        auto_create_schema=True,
    )


def scenario(name="baseline"):
    return {
        "name": name,
        "durationSeconds": 60,
        "yieldstepSeconds": 10,
        "frictionScenario": "middle",
        "inlets": [{
            "id": "inlet-a",
            "name": "west",
            "enabled": True,
            "cellIds": ["r0000-c0000", "r0000-c0001"],
            "dischargeM3s": 10,
            "velocityMode": "zero",
            "initialWaterLevelM": None,
            "displayColor": "#00D8FF",
        }],
    }


def client(tmp_path):
    database = Database(f"sqlite:///{tmp_path / 'api.sqlite'}")
    dispatched = []
    app = create_app(
        settings=settings(str(database.engine.url)),
        database=database,
        catalog=FakeCatalog(),
        dispatcher=dispatched.append,
    )
    return TestClient(app), dispatched


def test_model_catalog_and_grid_are_available(tmp_path):
    test_client, _ = client(tmp_path)
    with test_client:
        model = test_client.get("/api/model")
        grid = test_client.get("/api/model/grid")
        cell = test_client.get("/api/model/grid/r0000-c0001")
        selection = test_client.post(
            "/api/model/selection/resolve",
            json={
                "cellIds": ["r0000-c0000", "r0000-c0001"],
                "frictionScenario": "middle",
            },
        )

    assert model.status_code == 200
    assert model.json()["selectableCellCount"] == 6
    assert grid.json()["type"] == "FeatureCollection"
    assert cell.json()["effective_triangle_area_m2"] == 450
    assert "triangle_ids" not in cell.json()
    assert selection.json()["triangleCount"] == 2
    assert selection.json()["effectiveTriangleAreaM2"] == 900
    assert selection.json()["manning"] == {"minimum": 0.05, "maximum": 0.05}


def test_scenario_update_replaces_all_inlets_transactionally(tmp_path):
    test_client, _ = client(tmp_path)
    with test_client:
        created = test_client.post("/api/scenarios", json=scenario())
        scenario_id = created.json()["id"]
        replacement = scenario("updated")
        replacement["inlets"][0]["cellIds"] = ["r0001-c0000"]
        updated = test_client.put(
            f"/api/scenarios/{scenario_id}", json=replacement
        )
        validation = test_client.post(
            f"/api/scenarios/{scenario_id}/validate"
        )

    assert created.status_code == 201, created.text
    assert updated.status_code == 200, updated.text
    assert updated.json()["name"] == "updated"
    assert updated.json()["inlets"][0]["cellIds"] == ["r0001-c0000"]
    assert validation.json()["valid"] is True
    assert validation.json()["summary"]["frameCount"] == 7


def test_invalid_disconnected_selection_is_rejected(tmp_path):
    test_client, _ = client(tmp_path)
    invalid = scenario()
    invalid["inlets"][0]["cellIds"] = ["r0000-c0000", "r0000-c0002"]

    with test_client:
        response = test_client.post("/api/scenarios", json=invalid)

    assert response.status_code == 422
    assert "four-neighbour connected" in response.text


def test_job_keeps_immutable_snapshot_and_is_dispatched(tmp_path):
    test_client, dispatched = client(tmp_path)
    with test_client:
        created = test_client.post("/api/scenarios", json=scenario())
        scenario_id = created.json()["id"]
        job = test_client.post(
            f"/api/scenarios/{scenario_id}/jobs",
            json={"confirmWarnings": False},
        )
        replacement = scenario("changed after submission")
        test_client.put(f"/api/scenarios/{scenario_id}", json=replacement)
        stored_job = test_client.get(f"/api/jobs/{job.json()['id']}")

    assert job.status_code == 202, job.text
    assert dispatched == [job.json()["id"]]
    assert stored_job.json()["scenarioSnapshot"]["name"] == "baseline"
    assert stored_job.json()["frameCount"] == 7


def test_job_requires_explicit_confirmation_for_validation_warnings(tmp_path):
    test_client, dispatched = client(tmp_path)
    payload = scenario()
    payload["inlets"][0]["initialWaterLevelM"] = 30

    with test_client:
        created = test_client.post("/api/scenarios", json=payload)
        scenario_id = created.json()["id"]
        rejected = test_client.post(
            f"/api/scenarios/{scenario_id}/jobs",
            json={"confirmWarnings": False},
        )
        accepted = test_client.post(
            f"/api/scenarios/{scenario_id}/jobs",
            json={"confirmWarnings": True},
        )

    assert rejected.status_code == 409
    assert rejected.json()["detail"]["warnings"][0]["code"] == (
        "HIGH_INITIAL_WATER_LEVEL"
    )
    assert accepted.status_code == 202
    assert dispatched == [accepted.json()["id"]]


def test_sse_reconnect_catches_up_only_missing_frames(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "apps.api.main.httpx.get",
        lambda *args, **kwargs: SimpleNamespace(
            status_code=200,
            json=lambda: {"values": [1.25, 6.5, 0.75]},
        ),
    )
    test_client, _ = client(tmp_path)
    with test_client:
        created = test_client.post("/api/scenarios", json=scenario())
        job = test_client.post(
            f"/api/scenarios/{created.json()['id']}/jobs", json={}
        ).json()
        database = test_client.app.state.database
        with database.session_factory.begin() as session:
            stored_job = session.get(SimulationJob, job["id"])
            stored_job.status = "COMPLETED"
            for index in (0, 1):
                session.add(SimulationFrame(
                    job_id=job["id"],
                    frame_index=index,
                    time_seconds=index * 10,
                    cog_uri=f"s3://test/{index}.tif",
                    maximum_depth_m=index,
                    maximum_speed_mps=index,
                    wet_area_m2=index * 900,
                ))
        response = test_client.get(
            f"/api/jobs/{job['id']}/events",
            headers={"Last-Event-ID": "0"},
        )
        tilejson = test_client.get(
            f"/api/jobs/{job['id']}/frames/1/tilejson/depth"
        )
        point = test_client.get(
            f"/api/jobs/{job['id']}/frames/1/point",
            params={"longitude": 122.18, "latitude": 40.3},
        )
        monkeypatch.setattr(
            "apps.api.main.httpx.get",
            lambda *args, **kwargs: SimpleNamespace(status_code=404),
        )
        empty_tile = test_client.get(
            f"/api/jobs/{job['id']}/frames/1/tiles/depth/0/0/0.png"
        )

    assert response.status_code == 200
    assert "event: frame.ready" in response.text
    assert "id: 1" in response.text
    assert "id: 0" not in response.text
    assert "event: job.completed" in response.text
    assert tilejson.status_code == 200
    assert tilejson.json()["tiles"][0].endswith(
        "/tiles/depth/{z}/{x}/{y}.png"
    )
    assert point.json()["depthM"] == 1.25
    assert point.json()["stageM"] == 6.5
    assert point.json()["speedMps"] == 0.75
    assert empty_tile.status_code == 200
    assert empty_tile.headers["content-type"] == "image/png"
    Image.open(BytesIO(empty_tile.content)).verify()


def test_tile_display_mask_uses_depth_threshold():
    png = BytesIO()
    Image.new("RGBA", (2, 1), (20, 100, 200, 255)).save(png, "PNG")
    with MemoryFile() as memory_file:
        with memory_file.open(
            driver="GTiff", width=2, height=1, count=1, dtype="float32",
            transform=from_origin(0, 1, 1, 1),
        ) as dataset:
            dataset.write(np.array([[[0.0, 0.2]]], dtype=np.float32))
        masked = _apply_depth_mask(png.getvalue(), memory_file.read())

    alpha = np.asarray(Image.open(BytesIO(masked)))[..., 3]
    np.testing.assert_array_equal(alpha, [[0, 255]])
