from __future__ import annotations
import json

from types import SimpleNamespace

import numpy as np
import rasterio
from rasterio.enums import MaskFlags
from rasterio.transform import from_origin
import fiona
from shapely.geometry import box, mapping
from apps.api.db import Database
from apps.api.dem_products import DemProductCatalog, register_manifest

from bayuquan.build_web_map_assets import (
    build_aligned_derived_dem,
    build_aligned_derived_inputs,
    build_dem_cog,
    build_model_inputs_cog,
    build_reprojected_dem,
    write_product_manifest,
)

from bayuquan.raster import (
    CogWriter,
    FrameRasterizer,
    LocalFrameRasterizer,
    RasterGrid,
    build_interpolation_mapping,
)
from bayuquan.simulation.area import SimulationArea


class Quantity:
    def __init__(self, values):
        self.vertex_values = np.asarray(values, dtype=float)


def square_mapping():
    grid = RasterGrid(
        rows=1,
        columns=2,
        cellsize=1,
        xllcorner=0,
        yllcorner=0,
    )
    vertices = np.array([
        [[0, 0], [1, 0], [0, 1]],
        [[1, 0], [2, 0], [2, 1]],
    ], dtype=float)
    return build_interpolation_mapping(vertices, grid, "mesh-hash")


def frame(depth=2):
    mapping = square_mapping()
    vertices = np.array([
        [[0, 0], [1, 0], [0, 1]],
        [[1, 0], [2, 0], [2, 1]],
    ], dtype=float)
    elevation = vertices[:, :, 0]
    domain = SimpleNamespace(quantities={
        "elevation": Quantity(elevation),
        "stage": Quantity(elevation + depth),
        "xmomentum": Quantity(np.full((2, 3), 2 * depth)),
        "ymomentum": Quantity(np.zeros((2, 3))),
    })
    return FrameRasterizer(mapping).rasterize(domain, 300)


def test_rasterizer_interpolates_velocity_components_at_pixel_centres():
    result = frame()

    np.testing.assert_allclose(result.values[0], [[2, 2]])
    np.testing.assert_allclose(result.values[1], [[2.5, 3.5]])
    np.testing.assert_allclose(result.values[2], [[2, 2]])
    np.testing.assert_allclose(result.values[3], [[2, 2]])
    np.testing.assert_allclose(result.values[4], [[0, 0]])
    np.testing.assert_array_equal(result.display_mask, [[True, True]])
    assert result.maximum_depth_m == 2
    assert result.maximum_speed_mps == 2
    assert result.wet_area_m2 == 2


def test_cog_writer_publishes_aligned_five_band_flow_cog(tmp_path):
    result = frame()
    target = tmp_path / "000000300.tif"

    written = CogWriter(square_mapping().grid).write(result, target)

    assert written.path == target
    assert written.size_bytes > 0
    assert not list(tmp_path.glob(".*.tif"))
    with rasterio.open(target) as dataset:
        assert dataset.driver == "GTiff"
        assert dataset.shape == (1, 2)
        assert dataset.count == 5
        assert dataset.crs.to_string() == "EPSG:32651"
        assert dataset.transform == rasterio.Affine(1, 0, 0, 0, -1, 1)
        assert dataset.descriptions == (
            "depth", "stage", "speed", "velocity_u", "velocity_v",
        )
        assert dataset.units == ("m", "m", "m/s", "m/s", "m/s")
        assert dataset.nodata == -9999
        assert dataset.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
        np.testing.assert_allclose(dataset.read(), result.values)
        assert MaskFlags.per_dataset in dataset.mask_flag_enums[0]


def test_web_dem_builder_creates_tiled_cog_with_overviews(tmp_path):
    source = tmp_path / "source.tif"
    target = tmp_path / "web" / "elevation_cog.tif"
    with rasterio.open(
        source,
        "w",
        driver="GTiff",
        width=1024,
        height=1024,
        count=1,
        dtype="int16",
        crs="EPSG:32651",
        transform=from_origin(326000, 4541000, 30, 30),
        nodata=32767,
    ) as dataset:
        values = np.arange(1024, dtype=np.int16)[None, None, :]
        dataset.write(values.repeat(1024, axis=1))

    build_dem_cog(source, target)

    with rasterio.open(target) as dataset:
        assert dataset.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
        assert dataset.block_shapes[0] == (512, 512)
        assert dataset.overviews(1)
        assert dataset.nodata == 32767
    assert target.stat().st_mode & 0o444 == 0o444


def test_dry_pixels_keep_values_but_are_excluded_from_display_mask():
    result = frame(depth=0)

    np.testing.assert_allclose(result.values[0], [[0, 0]])
    np.testing.assert_allclose(result.values[1], [[0.5, 1.5]])
    np.testing.assert_array_equal(result.display_mask, [[False, False]])
    assert result.wet_area_m2 == 0


def test_reprojected_dem_uses_model_crs_and_metric_resolution(tmp_path):
    source = tmp_path / "byq-5m.tif"
    target = tmp_path / "web" / "elevation_5m_cog.tif"
    with rasterio.open(
        source,
        "w",
        driver="GTiff",
        width=64,
        height=64,
        count=1,
        dtype="float32",
        crs="EPSG:4490",
        transform=from_origin(122, 40.01, 0.00005, 0.00005),
        nodata=-32767,
    ) as dataset:
        dataset.write(np.ones((64, 64), dtype="float32"), 1)

    result = build_reprojected_dem(
        source,
        target,
        target_crs="EPSG:32651",
        resolution_m=5,
    )

    assert result == target.resolve()
    with rasterio.open(target) as dataset:
        assert dataset.crs.to_string() == "EPSG:32651"
        assert np.isclose(abs(dataset.transform.a), 5)
        assert np.isclose(abs(dataset.transform.e), 5)
        assert dataset.tags()["SOURCE_CRS"] == "EPSG:4490"


def test_model_input_builder_treats_outside_building_coverage_as_zero(
    tmp_path,
):
    dem = tmp_path / "dem.tif"
    buildings = tmp_path / "buildings.gpkg"
    target = tmp_path / "web" / "model_inputs_cog.tif"
    transform = from_origin(100, 220, 30, 30)
    values = np.ones((4, 4), dtype=np.int16)
    values[3, 3] = 32767
    with rasterio.open(
        dem,
        "w",
        driver="GTiff",
        width=4,
        height=4,
        count=1,
        dtype="int16",
        crs="EPSG:32651",
        transform=transform,
        nodata=32767,
    ) as dataset:
        dataset.write(values, 1)
    with fiona.open(
        buildings,
        "w",
        driver="GPKG",
        layer="building_footprints",
        crs="EPSG:32651",
        schema={"geometry": "Polygon", "properties": {}},
    ) as sink:
        sink.write({
            "geometry": mapping(box(100, 190, 145, 220)),
            "properties": {},
        })

    result = build_model_inputs_cog(dem, buildings, target)

    assert result == target.resolve()
    with rasterio.open(target) as dataset:
        assert dataset.shape == (4, 4)
        assert dataset.transform == transform
        assert dataset.crs.to_string() == "EPSG:32651"
        assert dataset.descriptions == (
            "building_fraction",
            "building_density_class",
            "manning_low",
            "manning_middle",
            "manning_high",
        )
        assert len(dataset.tags()["MODEL_INPUT_VERSION"]) == 64
        data = dataset.read()
        np.testing.assert_allclose(data[:, 0, 0], [1, 4, 0.1, 0.16, 0.2])
        np.testing.assert_allclose(data[:, 0, 1], [0.5, 4, 0.1, 0.16, 0.2])
        np.testing.assert_allclose(data[:, 1, 3], [0, 0, 0.03, 0.04, 0.05])
        np.testing.assert_array_equal(data[:, 3, 3], np.full(5, -9999))


def test_derived_product_is_nested_and_preserves_30m_input_cells(tmp_path):
    dem = tmp_path / "dem-30m.tif"
    inputs = tmp_path / "inputs-30m.tif"
    transform = from_origin(100, 220, 30, 30)
    with rasterio.open(
        dem, "w", driver="GTiff", width=2, height=2, count=1,
        dtype="float32", crs="EPSG:32651", transform=transform,
        nodata=-9999,
    ) as dataset:
        dataset.write(np.array([[0, 20], [55, -9999]], dtype="float32"), 1)
    with rasterio.open(
        inputs, "w", driver="GTiff", width=2, height=2, count=5,
        dtype="float32", crs="EPSG:32651", transform=transform,
        nodata=-9999,
    ) as dataset:
        dataset.descriptions = (
            "building_fraction", "building_density_class", "manning_low",
            "manning_middle", "manning_high",
        )
        values = np.arange(20, dtype="float32").reshape(5, 2, 2)
        values[:, 1, 1] = -9999
        dataset.write(values)

    derived_dem = build_aligned_derived_dem(
        dem, tmp_path / "dem-10m.tif"
    )
    derived_inputs = build_aligned_derived_inputs(
        inputs, tmp_path / "inputs-10m.tif"
    )
    fine_dem = tmp_path / "dem-5m.tif"
    fine_inputs = tmp_path / "inputs-5m.tif"
    fine_transform = from_origin(100, 220, 5, 5)
    with rasterio.open(
        fine_dem, "w", driver="GTiff", width=12, height=12, count=1,
        dtype="float32", crs="EPSG:32651", transform=fine_transform,
        nodata=-9999,
    ) as dataset:
        dataset.write(np.ones((12, 12), dtype="float32"), 1)
    with rasterio.open(
        fine_inputs, "w", driver="GTiff", width=12, height=12, count=5,
        dtype="float32", crs="EPSG:32651", transform=fine_transform,
        nodata=-9999,
    ) as dataset:
        dataset.descriptions = (
            "building_fraction", "building_density_class", "manning_low",
            "manning_middle", "manning_high",
        )
        dataset.write(np.ones((5, 12, 12), dtype="float32"))

    manifest = write_product_manifest(
        tmp_path / "products.json", dem, inputs,
        derived_dem, derived_inputs, vertical_datum="TEST-DATUM",
        additional_products=({
            "id": "bayuquan-dem-5m-v1",
            "name": "鲅鱼圈原始 DEM · 5 m",
            "dem": fine_dem,
            "inputs": fine_inputs,
            "cell_size": 5,
            "max_cells": 500_000,
            "queue": "high-resource",
            "default": True,
        },),
    )

    with rasterio.open(derived_dem) as dataset:
        assert dataset.shape == (6, 6)
        assert dataset.transform == from_origin(100, 220, 10, 10)
        assert dataset.dtypes == ("float32",)
        assert np.any(dataset.read(1)[:3, :3] % 1 != 0)
        assert np.all(dataset.read(1)[3:, 3:] == -9999)
        assert dataset.tags()["DERIVATION_ALGORITHM"].startswith("bilinear")
    with rasterio.open(derived_inputs) as dataset:
        assert dataset.shape == (6, 6)
        data = dataset.read()
        np.testing.assert_array_equal(data[:, :3, :3], np.broadcast_to(
            np.arange(0, 20, 4, dtype="float32")[:, None, None],
            (5, 3, 3),
        ))
        assert np.all(data[:, 3:, 3:] == -9999)
    document = json.loads(manifest.read_text())
    assert document["products"][1]["isDefault"] is False
    assert document["products"][1]["maxCells"] == 125_000
    assert document["products"][1]["sourceResolutionM"] == 30
    assert document["products"][2]["id"] == "bayuquan-dem-5m-v1"
    assert document["products"][2]["maxCells"] == 500_000
    database = Database(f"sqlite:///{tmp_path / 'products.sqlite'}")
    database.create_schema()
    register_manifest(database, manifest)
    catalog = DemProductCatalog(database, tmp_path / "areas")
    assert catalog.default().id == "bayuquan-dem-5m-v1"
    assert catalog.default().max_cells == 500_000
    assert catalog.get("bayuquan-dem-5m-v1").cell_size_m == 5


def test_local_rasterizer_aggregates_two_triangles_per_selected_cell():
    area = SimulationArea(
        area_hash="a" * 64,
        dataset_version="v1",
        crs="EPSG:32651",
        cell_ids=("r0001-c0001", "r0001-c0002"),
        cell_indices=(5, 6),
        cell_rows=(1, 1),
        cell_columns=(1, 2),
        nrows=3,
        ncols=4,
        transform=(30, 0, 100, 0, -30, 300),
        window=(1, 2, 1, 3),
        cell_size_m=30,
        elevation_m={"minimum": 0, "maximum": 0, "mean": 0},
    )
    domain = SimpleNamespace(quantities={
        "elevation": SimpleNamespace(centroid_values=np.zeros(4)),
        "stage": SimpleNamespace(centroid_values=np.array([1, 3, 2, 4])),
        "xmomentum": SimpleNamespace(
            centroid_values=np.array([1, 3, 4, 8])
        ),
        "ymomentum": SimpleNamespace(centroid_values=np.zeros(4)),
    })
    rasterizer = LocalFrameRasterizer(
        area,
        triangle_cell_index=np.array([5, 5, 6, 6]),
        triangle_area_m2=np.full(4, 450),
    )

    result = rasterizer.rasterize(domain, 10)

    np.testing.assert_allclose(result.values[0], [[2, 3]])
    np.testing.assert_allclose(result.values[3], [[1, 2]])
    np.testing.assert_allclose(result.values[4], [[0, 0]])
    assert rasterizer.grid.transform_tuple == (30, 0, 130, 0, -30, 270)
    assert result.wet_area_m2 == 1800
