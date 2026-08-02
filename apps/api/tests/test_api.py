from __future__ import annotations

from types import SimpleNamespace

from pathlib import Path
from io import BytesIO
from struct import unpack_from

from PIL import Image
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_origin

import pytest
import numpy as np
from fastapi.testclient import TestClient

from apps.api.config import Settings
from apps.api.db import Database
from apps.api.main import _apply_depth_mask, _simulation_area_bounds, create_app
from apps.api.models import SimulationFrame, SimulationJob
from bayuquan.simulation.grid_mapping import GridTriangleMapping


def test_legacy_job_snapshot_without_area_has_no_map_bounds():
    assert _simulation_area_bounds({"name": "legacy"}) is None


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
            "demTilejsonUrl": "/api/model/dem/tilejson",
            "boundaryCondition": "transmissive",
            "meshSha256": self.mapping.mesh_sha256,
        }

    def cell(self, cell_id):
        return self.cells.get(cell_id)


class FakeAreaCatalog:
    def metadata(self):
        return {
            "version": "dataset-",
            "datasetVersion": "dataset-v1",
            "crs": "EPSG:32651",
            "gridRows": 2,
            "gridColumns": 3,
            "cellSizeM": 30,
            "simulationAreaResolveUrl": (
                "/api/model/simulation-areas/resolve"
            ),
            "demTilejsonUrl": "/api/model/dem/tilejson",
            "boundaryCondition": "transmissive",
            "maxSimulationAreaCells": 25_000,
        }

    def __init__(self):
        self._mapping = GridTriangleMapping(
            triangle_cell_index=np.arange(6, dtype=np.int32),
            triangle_area_m2=np.full(6, 450.0),
            nrows=2,
            ncols=3,
            cellsize=30,
            xllcorner=100,
            yllcorner=200,
            mesh_sha256="b" * 64,
        )

    def area(self, area_hash):
        if area_hash != "b" * 64:
            raise KeyError(area_hash)
        return SimpleNamespace(
            area_hash="b" * 64,
            dataset_version="dataset-v1",
            crs="EPSG:32651",
            cell_count=2,
            area_m2=1800,
            cell_size_m=30,
            window=(10, 11, 20, 22),
            elevation_m={"minimum": 3.0, "maximum": 4.0, "mean": 3.5},
        )

    def mapping(self, area_hash):
        self.area(area_hash)
        return self._mapping

    def snapshot(self, area_hash):
        self.area(area_hash)
        return {
            "areaHash": area_hash,
            "datasetVersion": "dataset-v1",
            "crs": "OGC:CRS84",
            "transform": [0.01, 0, 122, 0, -0.01, 41],
            "window": [10, 12, 20, 23],
            "meshRule": "square-sw-ne-v1",
            "cellIds": ["r0000-c0000", "r0000-c0001"],
        }

    def resolve(self, geometry):
        assert geometry["type"] == "Polygon"
        return SimpleNamespace(
            area_hash="b" * 64,
            dataset_version="dataset-v1",
            crs="EPSG:32651",
            cell_count=2,
            area_m2=1800,
            cell_size_m=30,
            window=(10, 11, 20, 22),
            elevation_m={"minimum": 3.0, "maximum": 4.0, "mean": 3.5},
        )

    def resolve_selection(self, area_hash, cell_ids, friction_scenario):
        assert area_hash == "b" * 64
        assert cell_ids == ["r0010-c0020"]
        assert friction_scenario == "middle"
        return {
            "cellIds": cell_ids,
            "cellCount": 1,
            "geometricAreaM2": 900,
            "triangleCount": 2,
            "effectiveTriangleAreaM2": 900,
            "elevationM": {"minimum": 3, "maximum": 3, "mean": 3},
            "buildingFraction": {"minimum": 0, "maximum": 0},
            "manning": {"minimum": 0.04, "maximum": 0.04},
        }

    def grid(self, area_hash):
        if area_hash != "b" * 64:
            raise KeyError(area_hash)
        return {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "properties": {
                    "cell_id": "r0010-c0020",
                    "elevation_m": 3,
                    "building_fraction": 0,
                    "manning_middle": 0.04,
                },
                "geometry": None,
            }] + [{
                "type": "Feature",
                "properties": {
                    "cell_id": f"r{row:04d}-c{column:04d}",
                    "elevation_m": 5,
                    "building_fraction": 0.1,
                    "manning_middle": 0.05,
                },
                "geometry": None,
            } for row in range(2) for column in range(3)],
        }


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
        "demProductId": "dem-test",
        "simulationAreaId": "b" * 64,
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
        area_catalog=FakeAreaCatalog(),
        dispatcher=lambda job_id, queue: dispatched.append(job_id),
    )
    return TestClient(app), dispatched


def test_model_metadata_does_not_publish_a_full_domain_grid(tmp_path):
    test_client, _ = client(tmp_path)
    with test_client:
        model = test_client.get("/api/dem-products")
        grid = test_client.get("/api/model/grid")

    assert model.status_code == 200
    assert model.json()["defaultDemProductId"] == "dem-test"
    assert model.json()["products"][0]["datasetVersion"] == "dataset-v1"
    assert model.json()["products"][0]["demTilejsonUrl"] == (
        "/api/dem-products/dem-test/tilejson"
    )
    assert grid.status_code == 404


def test_simulation_area_is_resolved_before_its_local_grid_is_loaded(tmp_path):
    test_client, _ = client(tmp_path)
    geometry = {
        "type": "Polygon",
        "coordinates": [[[122, 40], [122.1, 40], [122.1, 40.1],
                         [122, 40.1], [122, 40]]],
    }

    with test_client:
        resolved = test_client.post(
            "/api/dem-products/dem-test/simulation-areas/resolve",
            json={"geometry": geometry},
        )
        restored = test_client.get(
            f"/api/dem-products/dem-test/simulation-areas/{'b' * 64}"
        )
        grid = test_client.get(
            f"/api/dem-products/dem-test/simulation-areas/{'b' * 64}/grid"
        )
        selection = test_client.post(
            f"/api/dem-products/dem-test/simulation-areas/{'b' * 64}/selection/resolve",
            json={"cellIds": ["r0010-c0020"], "frictionScenario": "middle"},
        )
        missing = test_client.get(
            f"/api/dem-products/dem-test/simulation-areas/{'c' * 64}/grid"
        )

    assert resolved.status_code == 201, resolved.text
    assert restored.status_code == 200, restored.text
    assert restored.json() == resolved.json()
    assert resolved.json() == {
        "id": "b" * 64,
        "areaHash": "b" * 64,
        "demProductId": "dem-test",
        "datasetVersion": "dataset-v1",
        "crs": "EPSG:32651",
        "cellCount": 2,
        "areaM2": 1800,
        "cellSizeM": 30,
        "triangleCount": 4,
        "window": {"rowStart": 10, "rowStop": 11,
                   "columnStart": 20, "columnStop": 22},
        "elevationM": {"minimum": 3.0, "maximum": 4.0, "mean": 3.5},
        "gridUrl": f"/api/dem-products/dem-test/simulation-areas/{'b' * 64}/grid",
        "boundaryCondition": "transmissive",
    }
    assert grid.status_code == 200
    assert selection.status_code == 200
    assert selection.json()["triangleCount"] == 2
    assert grid.json()["features"][0]["properties"]["cell_id"] == (
        "r0010-c0020"
    )
    assert missing.status_code == 404


def test_simulation_area_rejection_is_returned_as_validation_error(tmp_path):
    test_client, _ = client(tmp_path)

    def reject_area(_geometry):
        raise ValueError(
            "simulation area cells must be four-neighbour connected"
        )

    test_client.app.state.dem_products.catalog.resolve = reject_area

    with test_client:
        response = test_client.post(
            "/api/dem-products/dem-test/simulation-areas/resolve",
            json={"geometry": {"type": "Polygon", "coordinates": []}},
        )

    assert response.status_code == 422
    assert "four-neighbour connected" in response.text


def test_model_dem_tiles_are_rendered_through_titiler(
    tmp_path, monkeypatch
):
    tile = BytesIO()
    Image.new("RGBA", (1, 1), (20, 80, 40, 255)).save(tile, "PNG")
    requests = []

    def render(url, *, params, timeout):
        requests.append((url, params, timeout))
        return SimpleNamespace(status_code=200, content=tile.getvalue())

    monkeypatch.setattr("apps.api.main.httpx.get", render)
    test_client, _ = client(tmp_path)
    with test_client:
        tilejson = test_client.get("/api/dem-products/dem-test/tilejson")
        rendered = test_client.get(
            "/api/dem-products/dem-test/tiles/13/6876/3092.png"
        )

    assert tilejson.status_code == 200
    assert tilejson.json()["tiles"] == [
        "/api/dem-products/dem-test/tiles/{z}/{x}/{y}.png"
    ]
    assert rendered.status_code == 200
    assert rendered.headers["content-type"] == "image/png"
    assert rendered.headers["cache-control"] == "public, max-age=86400"
    assert requests == [(
        "http://unused/cog/tiles/WebMercatorQuad/13/6876/3092.png",
        {
            "url": "/test/dem.tif",
            "bidx": 1,
            "rescale": "-36,100",
            "colormap_name": "terrain",
            "resampling": "bilinear",
        },
        20,
    )]


def test_model_terrain_tiles_are_versioned_and_terrain_rgb_encoded(
    tmp_path, monkeypatch
):
    tile = BytesIO()
    Image.new("RGBA", (1, 1), (1, 134, 160, 255)).save(tile, "PNG")
    requests = []

    def render(url, *, params, timeout):
        requests.append((url, params, timeout))
        return SimpleNamespace(status_code=200, content=tile.getvalue())

    monkeypatch.setattr("apps.api.main.httpx.get", render)
    test_client, _ = client(tmp_path)
    with test_client:
        model = test_client.get("/api/dem-products")
        tilejson = test_client.get(
            "/api/dem-products/dem-test/terrain/tilejson"
        )
        rendered = test_client.get(
            "/api/dem-products/dem-test/terrain/tiles/14/13753/6184.png"
        )
        stale = test_client.get(
            "/api/dem-products/stale/terrain/tiles/14/13753/6184.png"
        )

    assert model.json()["products"][0]["terrainTilejsonUrl"] == (
        "/api/dem-products/dem-test/terrain/tilejson"
    )
    assert tilejson.json() == {
        "tilejson": "3.0.0",
        "name": "Test DEM 3D terrain",
        "tiles": [
            "/api/dem-products/dem-test/terrain/tiles/{z}/{x}/{y}.png"
        ],
        "minzoom": 0,
        "maxzoom": 14,
        "encoding": "mapbox",
    }
    assert rendered.status_code == 200
    assert rendered.headers["cache-control"] == (
        "public, max-age=2592000, immutable"
    )
    assert stale.status_code == 404
    assert requests == [(
        "http://unused/cog/tiles/WebMercatorQuad/14/13753/6184.png",
        {
            "url": "/test/dem.tif",
            "bidx": 1,
            "resampling": "bilinear",
            "algorithm": "terrainrgb",
        },
        20,
    )]


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


def test_scenario_dem_product_is_locked_after_area_resolution(tmp_path):
    test_client, _ = client(tmp_path)
    with test_client:
        created = test_client.post("/api/scenarios", json=scenario())
        replacement = scenario("wrong product")
        replacement["demProductId"] = "another-product"
        response = test_client.put(
            f"/api/scenarios/{created.json()['id']}", json=replacement
        )

    assert response.status_code == 409
    assert "DEM product is locked" in response.text


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
    assert stored_job.json()["demProductId"] == "dem-test"
    assert stored_job.json()["simulationAreaId"] == "b" * 64
    assert stored_job.json()["simulationAreaBounds"] == [
        122.2, 40.88, 122.23, 40.9,
    ]
    assert stored_job.json()["scenarioSnapshot"]["simulationAreaId"] == (
        "b" * 64
    )
    assert stored_job.json()["scenarioSnapshot"]["simulationArea"] == {
        "areaHash": "b" * 64,
        "datasetVersion": "dataset-v1",
        "crs": "OGC:CRS84",
        "transform": [0.01, 0, 122, 0, -0.01, 41],
        "window": [10, 12, 20, 23],
        "meshRule": "square-sw-ne-v1",
        "cellIds": ["r0000-c0000", "r0000-c0001"],
    }
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


def test_flow_field_endpoint_publishes_wet_velocity_components(tmp_path):
    cog = tmp_path / "flow.tif"
    values = np.array([
        [[0.0, 1.0]],
        [[5.0, 6.0]],
        [[0.0, 5.0]],
        [[9.0, 3.0]],
        [[8.0, 4.0]],
    ], dtype=np.float32)
    with rasterio.open(
        cog, "w", driver="GTiff", width=2, height=1, count=5,
        dtype="float32", crs="EPSG:32651",
        transform=from_origin(430_000, 4_462_000, 30, 30),
        nodata=-9999,
    ) as dataset:
        dataset.write(values)
        dataset.write_mask(np.array([[0, 255]], dtype=np.uint8))

    test_client, _ = client(tmp_path)
    test_client.app.state.s3_client = SimpleNamespace(
        get_object=lambda **kwargs: {"Body": BytesIO(cog.read_bytes())}
    )
    with test_client:
        created = test_client.post("/api/scenarios", json=scenario())
        job = test_client.post(
            f"/api/scenarios/{created.json()['id']}/jobs", json={}
        ).json()
        database = test_client.app.state.database
        with database.session_factory.begin() as session:
            session.add(SimulationFrame(
                job_id=job["id"], frame_index=0, time_seconds=0,
                cog_uri="s3://simulation-jobs/jobs/test/flow.tif",
                maximum_depth_m=1, maximum_speed_mps=5,
                wet_area_m2=900,
            ))
        response = test_client.get(
            f"/api/jobs/{job['id']}/frames/0/flow"
        )

    assert response.status_code == 200
    assert response.headers["content-type"] == (
        "application/vnd.bayuquan.flow-field"
    )
    magic, version, width, height, _reserved = unpack_from(
        "<4sHHHH", response.content
    )
    assert (magic, version, width, height) == (b"BQFV", 4, 2, 1)
    nw_lon, nw_lat, ne_lon, ne_lat, sw_lon, sw_lat, se_lon, se_lat = (
        unpack_from("<8d", response.content, 12)
    )
    assert 121 < nw_lon < ne_lon < 123
    assert 121 < sw_lon < se_lon < 123
    assert 39 < sw_lat < nw_lat < 41
    assert 39 < se_lat < ne_lat < 41
    # v4 texels are (u, v, depth, stage) float16; dry cells carry the exact
    # sentinel depth -1 instead of NaN.
    texels = np.frombuffer(response.content, dtype="<f2", offset=76)
    np.testing.assert_array_equal(texels[:4], [0, 0, -1, 0])
    np.testing.assert_allclose(texels[4:], [3, 4, 1, 6])


def test_flow_field_endpoint_downsamples_to_max_dim(tmp_path):
    cog = tmp_path / "flow.tif"
    rng = np.random.default_rng(7)
    values = rng.random((5, 32, 64), dtype=np.float32) * 3
    with rasterio.open(
        cog, "w", driver="GTiff", width=64, height=32, count=5,
        dtype="float32", crs="EPSG:32651",
        transform=from_origin(430_000, 4_462_000, 30, 30),
        nodata=-9999,
    ) as dataset:
        dataset.write(values)
        dataset.write_mask(np.full((32, 64), 255, dtype=np.uint8))

    test_client, _ = client(tmp_path)
    test_client.app.state.s3_client = SimpleNamespace(
        get_object=lambda **kwargs: {"Body": BytesIO(cog.read_bytes())}
    )
    with test_client:
        created = test_client.post("/api/scenarios", json=scenario())
        job = test_client.post(
            f"/api/scenarios/{created.json()['id']}/jobs", json={}
        ).json()
        database = test_client.app.state.database
        with database.session_factory.begin() as session:
            session.add(SimulationFrame(
                job_id=job["id"], frame_index=0, time_seconds=0,
                cog_uri="s3://simulation-jobs/jobs/test/flow.tif",
                maximum_depth_m=1, maximum_speed_mps=5,
                wet_area_m2=900,
            ))
        response = test_client.get(
            f"/api/jobs/{job['id']}/frames/0/flow",
            params={"max_dim": 16},
        )
    assert response.status_code == 200
    magic, version, width, height, _reserved = unpack_from(
        "<4sHHHH", response.content
    )
    assert (magic, version, width, height) == (b"BQFV", 4, 16, 8)
    texels = np.frombuffer(
        response.content, dtype="<f2", offset=76,
    ).reshape(height, width, 4)
    assert np.isfinite(texels).all()
    assert (texels[..., 2] >= 0).all()
    # Downsampled depth stays close to the source mean.
    assert abs(float(texels[..., 2].mean()) - float(values[0].mean())) < 0.5


def test_rainfall_only_scenario_is_persisted_validated_and_snapshotted(
    tmp_path,
):
    test_client, dispatched = client(tmp_path)
    payload = scenario("rainfall only")
    payload["inlets"] = []
    payload["durationSeconds"] = 3600
    payload["rainfall"] = {
        "enabled": True,
        "points": [
            {"timeMinutes": 0, "intensityMmPerHour": 0},
            {"timeMinutes": 10, "intensityMmPerHour": 30},
            {"timeMinutes": 40, "intensityMmPerHour": 10},
        ],
    }

    with test_client:
        created = test_client.post("/api/scenarios", json=payload)
        scenario_id = created.json()["id"]
        validation = test_client.post(
            f"/api/scenarios/{scenario_id}/validate"
        )
        job = test_client.post(
            f"/api/scenarios/{scenario_id}/jobs",
            json={"confirmWarnings": False},
        )

    assert created.status_code == 201, created.text
    assert created.json()["rainfall"] == payload["rainfall"]
    assert validation.json()["valid"] is True
    summary = validation.json()["summary"]
    assert summary["enabledInletCount"] == 0
    assert summary["rainfallDepthMm"] == pytest.approx(18.333333)
    assert summary["peakRainfallMmPerHour"] == 30
    assert summary["rainfallInputVolumeM3"] == pytest.approx(33.0)
    assert job.status_code == 202, job.text
    assert job.json()["scenarioSnapshot"]["rainfall"] == payload["rainfall"]
    assert dispatched == [job.json()["id"]]


def test_legacy_scenario_without_rainfall_defaults_to_disabled(tmp_path):
    test_client, _ = client(tmp_path)

    with test_client:
        created = test_client.post("/api/scenarios", json=scenario())

    assert created.status_code == 201, created.text
    assert created.json()["rainfall"] == {"enabled": False, "points": []}


def test_invalid_enabled_rainfall_is_rejected(tmp_path):
    test_client, _ = client(tmp_path)
    payload = scenario()
    payload["rainfall"] = {
        "enabled": True,
        "points": [{"timeMinutes": 1, "intensityMmPerHour": 50}],
    }

    with test_client:
        response = test_client.post("/api/scenarios", json=payload)

    assert response.status_code == 422
    assert "first rainfall point" in response.text


def test_hydraulic_features_are_persisted_and_snapshotted(
    tmp_path, monkeypatch,
):
    monkeypatch.setattr(FakeAreaCatalog, "dem_path", "unused", raising=False)
    monkeypatch.setattr(
        "apps.api.scenarios.service.compile_features",
        lambda features, area, dem_path: SimpleNamespace(levees=[]),
    )
    test_client, _ = client(tmp_path)
    payload = scenario("levee scenario")
    payload["hydraulicFeatures"] = [
        {
            "type": "levee",
            "id": "levee-1",
            "name": "north levee",
            "enabled": True,
            "geometry": {
                "type": "LineString",
                "coordinates": [[122.18, 40.30], [122.181, 40.30]],
            },
            "crestMode": "relative",
            "heightAboveGroundM": 2,
            "qFactor": 1,
        },
        {
            "type": "drainageOutlet",
            "id": "drain-1",
            "name": "underpass drain",
            "enabled": True,
            "geometry": {
                "type": "Point",
                "coordinates": [122.1805, 40.3005],
            },
            "capacityM3s": 0.8,
            "intakeRadiusM": 10,
            "fullCapacityDepthM": 0.3,
            "blockage": 0.25,
        },
    ]

    with test_client:
        created = test_client.post("/api/scenarios", json=payload)
        assert created.status_code == 201, created.text
        scenario_id = created.json()["id"]
        loaded = test_client.get(f"/api/scenarios/{scenario_id}")
        assert loaded.json()[
            "hydraulicFeatures"] == payload["hydraulicFeatures"]

        validation = test_client.post(
            f"/api/scenarios/{scenario_id}/validate"
        )
        assert validation.status_code == 200
        assert validation.json()["summary"]["leveeCount"] == 1
        assert validation.json()["summary"]["structureCount"] == 1

        job = test_client.post(f"/api/scenarios/{scenario_id}/jobs", json={})
        assert job.status_code == 202
        assert job.json()["scenarioSnapshot"]["hydraulicFeatures"] \
            == payload["hydraulicFeatures"]
