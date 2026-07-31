from __future__ import annotations

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from bayuquan.simulation.area import (
    SimulationAreaError,
    SimulationAreaResolver,
    build_local_mesh,
)
from bayuquan.simulation.area_catalog import SimulationAreaCatalog


def write_dem(tmp_path, values):
    path = tmp_path / "dem.tif"
    values = np.asarray(values, dtype=np.float32)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=values.shape[1],
        height=values.shape[0],
        count=1,
        dtype=values.dtype,
        crs="EPSG:32651",
        transform=from_origin(100, 320, 30, 30),
        nodata=32767,
    ) as dataset:
        dataset.write(values, 1)
    return path


def write_model_inputs(tmp_path, shape):
    path = tmp_path / "model-inputs.tif"
    rows, columns = shape
    values = np.empty((5, rows, columns), dtype=np.float32)
    values[0] = 0.25
    values[1] = 2
    values[2] = 0.06
    values[3] = 0.08
    values[4] = 0.10
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=columns,
        height=rows,
        count=5,
        dtype="float32",
        crs="EPSG:32651",
        transform=from_origin(100, 320, 30, 30),
        nodata=-9999,
    ) as dataset:
        dataset.write(values)
        dataset.descriptions = (
            "building_fraction",
            "building_density_class",
            "manning_low",
            "manning_middle",
            "manning_high",
        )
    return path


def polygon(xmin, ymin, xmax, ymax):
    return {
        "type": "Polygon",
        "coordinates": [[
            [xmin, ymin],
            [xmax, ymin],
            [xmax, ymax],
            [xmin, ymax],
            [xmin, ymin],
        ]],
    }


def test_resolver_snaps_polygon_to_dem_cell_centres(tmp_path):
    resolver = SimulationAreaResolver(
        write_dem(tmp_path, np.arange(16).reshape(4, 4)),
        dataset_version="dem-v1",
        max_cells=25_000,
    )

    area = resolver.resolve(
        polygon(100, 260, 160, 320), geometry_crs="EPSG:32651"
    )

    assert area.cell_ids == (
        "r0000-c0000",
        "r0000-c0001",
        "r0001-c0000",
        "r0001-c0001",
    )
    assert area.cell_count == 4
    assert area.area_m2 == 3600
    assert area.window == (0, 2, 0, 2)
    assert area.elevation_m == {"minimum": 0.0, "maximum": 5.0, "mean": 2.5}
    assert len(area.area_hash) == 64


def test_area_hash_identifies_the_cell_mask_not_ring_order(tmp_path):
    resolver = SimulationAreaResolver(
        write_dem(tmp_path, np.ones((2, 2))), dataset_version="dem-v1"
    )
    clockwise = polygon(100, 260, 160, 320)
    counter_clockwise = {
        "type": "Polygon",
        "coordinates": [list(reversed(clockwise["coordinates"][0]))],
    }

    first = resolver.resolve(clockwise, geometry_crs="EPSG:32651")
    second = resolver.resolve(counter_clockwise, geometry_crs="EPSG:32651")

    assert first.area_hash == second.area_hash


def test_resolver_rejects_any_selected_nodata_cell(tmp_path):
    resolver = SimulationAreaResolver(
        write_dem(tmp_path, [[1, 32767, 1]]), dataset_version="dem-v1"
    )

    with pytest.raises(SimulationAreaError, match="contains DEM NoData"):
        resolver.resolve(
            polygon(100, 290, 190, 320), geometry_crs="EPSG:32651"
        )


def test_resolver_rejects_nodata_before_it_can_create_a_hole(tmp_path):
    values = np.ones((3, 3))
    values[1, 1] = 32767
    resolver = SimulationAreaResolver(
        write_dem(tmp_path, values), dataset_version="dem-v1"
    )

    with pytest.raises(SimulationAreaError, match="contains DEM NoData"):
        resolver.resolve(
            polygon(100, 230, 190, 320), geometry_crs="EPSG:32651"
        )


def test_resolver_enforces_the_cell_limit(tmp_path):
    resolver = SimulationAreaResolver(
        write_dem(tmp_path, np.ones((2, 2))),
        dataset_version="dem-v1",
        max_cells=3,
    )

    with pytest.raises(SimulationAreaError, match="maximum of 3"):
        resolver.resolve(
            polygon(100, 260, 160, 320), geometry_crs="EPSG:32651"
        )


def test_local_mesh_has_two_triangles_per_cell_and_only_outer_boundaries(
    tmp_path,
):
    resolver = SimulationAreaResolver(
        write_dem(tmp_path, np.ones((1, 2))), dataset_version="dem-v1"
    )
    area = resolver.resolve(
        polygon(100, 290, 160, 320), geometry_crs="EPSG:32651"
    )

    mesh = build_local_mesh(area)

    assert mesh.coordinates.shape == (6, 2)
    assert mesh.triangles.shape == (4, 3)
    assert len(mesh.boundary) == 6
    assert set(mesh.boundary.values()) == {"open"}
    np.testing.assert_array_equal(
        mesh.triangle_cell_index,
        [0, 0, 1, 1],
    )
    triangle_points = mesh.coordinates[mesh.triangles]
    first_edges = triangle_points[:, 1] - triangle_points[:, 0]
    second_edges = triangle_points[:, 2] - triangle_points[:, 0]
    twice_areas = np.abs(
        first_edges[:, 0] * second_edges[:, 1]
        - first_edges[:, 1] * second_edges[:, 0]
    )
    np.testing.assert_allclose(twice_areas / 2, 450)
    assert mesh.origin == (100.0, 290.0)


def test_area_catalog_caches_resolved_grid_and_mesh_by_hash(tmp_path):
    dem = write_dem(tmp_path, np.ones((1, 2)))
    catalog = SimulationAreaCatalog(
        dem,
        tmp_path / "areas",
        dataset_version="dem-v1",
        model_inputs_path=write_model_inputs(tmp_path, (1, 2)),
    )

    first = catalog.resolve(
        polygon(100, 290, 160, 320), geometry_crs="EPSG:32651"
    )
    second = catalog.resolve(
        polygon(100, 290, 160, 320), geometry_crs="EPSG:32651"
    )
    grid = catalog.grid(first.area_hash)

    assert second.area_hash == first.area_hash
    assert first.cell_count == 2
    assert [feature["properties"]["cell_id"] for feature in grid["features"]] == [
        "r0000-c0000",
        "r0000-c0001",
    ]
    assert grid["features"][0]["properties"]["building_fraction"] == 0.25
    assert grid["features"][0]["properties"]["manning_middle"] == pytest.approx(0.08)
    stats = catalog.resolve_selection(
        first.area_hash,
        ["r0000-c0000", "r0000-c0001"],
        "middle",
    )
    assert stats["triangleCount"] == 4
    assert stats["manning"] == pytest.approx({
        "minimum": 0.08,
        "maximum": 0.08,
    })
    assert (tmp_path / "areas" / first.area_hash / "area.json").is_file()
    with np.load(
        tmp_path / "areas" / first.area_hash / "mesh.npz",
        allow_pickle=False,
    ) as mesh:
        assert mesh["triangles"].shape == (4, 3)
        np.testing.assert_array_equal(mesh["triangle_cell_index"], [0, 0, 1, 1])


def test_local_mesh_runs_with_transmissive_boundary_and_conserves_flat_water(
    tmp_path,
):
    try:
        import anuga
    except FileNotFoundError as error:
        if "ninja" not in str(error):
            raise
        pytest.skip("local meson editable install references a removed ninja")

    resolver = SimulationAreaResolver(
        write_dem(tmp_path, np.zeros((1, 2))), dataset_version="dem-v1"
    )
    area = resolver.resolve(
        polygon(100, 290, 160, 320), geometry_crs="EPSG:32651"
    )
    mesh = build_local_mesh(area)
    domain = anuga.Domain(
        mesh.coordinates,
        mesh.triangles,
        mesh.boundary,
        geo_reference=anuga.Geo_reference(
            epsg=32651,
            xllcorner=mesh.origin[0],
            yllcorner=mesh.origin[1],
        ),
        verbose=False,
    )
    domain.set_flow_algorithm("DE0")
    domain.set_store(False)
    domain.set_quantity("elevation", 0.0)
    domain.set_quantity("stage", 1.0)
    domain.set_quantity("friction", 0.03)
    domain.set_boundary({"open": anuga.Transmissive_boundary(domain)})
    initial_volume = domain.get_water_volume()

    frames = list(domain.evolve(yieldstep=0.2, finaltime=1.0))

    assert frames == pytest.approx([0, 0.2, 0.4, 0.6, 0.8, 1.0])
    assert domain.get_water_volume() == pytest.approx(initial_volume)
