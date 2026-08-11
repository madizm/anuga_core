"""Behaviour tests for the experimental fill-spill preview seam."""

import json

import numpy as np
import pytest
import rasterio
from affine import Affine

from bayuquan.preview.cache import load_preprocessed, save_preprocessed
from bayuquan.preview.depth_cog import write_maximum_depth_cog
from bayuquan.preview.fill_spill import (
    Depression,
    DepressionHierarchy,
    DepressionMerge,
    DepressionNetwork,
)
from bayuquan.preview.local_preview import main as preview_main
from bayuquan.preview.preprocessing import preprocess_dem


def test_finite_rainfall_partially_fills_a_depression():
    network = DepressionNetwork([
        Depression(
            id=0,
            elevations_m=(0.0, 1.0),
            spill_elevation_m=2.0,
            catchment_area_m2=2.0,
        ),
    ], cell_area_m2=1.0)

    result = network.solve(effective_rainfall_depth_m=0.25)

    assert result.maximum_level_m == {0: pytest.approx(0.5)}
    assert result.retained_volume_m3 == pytest.approx(0.5)
    assert result.outflow_volume_m3 == pytest.approx(0.0)
    assert result.mass_balance_error_m3 == pytest.approx(0.0, abs=1.0e-12)


def test_overflow_is_routed_downstream_without_losing_water():
    network = DepressionNetwork([
        Depression(
            id=0,
            elevations_m=(0.0,),
            spill_elevation_m=1.0,
            catchment_area_m2=1.0,
            downstream_id=1,
        ),
        Depression(
            id=1,
            elevations_m=(0.0,),
            spill_elevation_m=2.0,
            catchment_area_m2=1.0,
        ),
    ], cell_area_m2=1.0)

    result = network.solve(effective_rainfall_depth_m=1.5)

    assert result.maximum_level_m == {
        0: pytest.approx(1.0),
        1: pytest.approx(2.0),
    }
    assert result.retained_volume_m3 == pytest.approx(3.0)
    assert result.outflow_volume_m3 == pytest.approx(0.0)
    assert result.mass_balance_error_m3 == pytest.approx(0.0, abs=1.0e-12)


def test_water_above_network_capacity_leaves_through_open_outlet():
    network = DepressionNetwork([
        Depression(
            id=4,
            elevations_m=(0.0,),
            spill_elevation_m=1.0,
            catchment_area_m2=1.0,
        ),
    ], cell_area_m2=1.0)

    result = network.solve(effective_rainfall_depth_m=2.5)

    assert result.retained_volume_m3 == pytest.approx(1.0)
    assert result.outflow_volume_m3 == pytest.approx(1.5)
    assert result.mass_balance_error_m3 == pytest.approx(0.0, abs=1.0e-12)


def test_result_restores_depths_without_a_full_depth_working_array():
    network = DepressionNetwork([
        Depression(
            id=0,
            elevations_m=(0.0,),
            spill_elevation_m=2.0,
            catchment_area_m2=1.0,
        ),
        Depression(
            id=1,
            elevations_m=(1.0,),
            spill_elevation_m=3.0,
            catchment_area_m2=1.0,
        ),
    ], cell_area_m2=1.0)
    result = network.solve(effective_rainfall_depth_m=1.0)

    depths = result.depths_for(
        basin_ids=np.array([[0, 0, -1], [1, 1, -1]], dtype=np.int32),
        elevations_m=np.array(
            [[0.25, 1.25, 9.0], [1.25, 2.25, np.nan]], dtype=np.float32
        ),
    )

    np.testing.assert_allclose(
        depths,
        np.array([[0.75, 0.0, np.nan], [0.75, 0.0, np.nan]], dtype=np.float32),
        equal_nan=True,
    )


def test_network_rejects_a_downstream_cycle():
    with pytest.raises(ValueError, match="cycle"):
        DepressionNetwork([
            Depression(0, (0.0,), 1.0, 1.0, downstream_id=1),
            Depression(1, (0.0,), 1.0, 1.0, downstream_id=0),
        ], cell_area_m2=1.0)


def test_priority_flood_preprocesses_a_hand_worked_bowl():
    elevations = np.array([
        [0, 0, 0, 0, 0, 0, 0],
        [0, 4, 4, 4, 4, 4, 0],
        [0, 4, 0, 0, 2, 1, 0],
        [0, 4, 4, 4, 4, 4, 0],
        [0, 0, 0, 0, 0, 0, 0],
    ], dtype=np.float32)

    preprocessed = preprocess_dem(elevations, cell_area_m2=25.0)

    assert len(preprocessed.depressions) == 1
    depression = preprocessed.depressions[0]
    assert depression.spill_elevation_m == pytest.approx(2.0)
    assert depression.catchment_area_m2 == pytest.approx(3 * 25.0)
    assert depression.downstream_id is None
    np.testing.assert_array_equal(
        preprocessed.basin_ids[2, 2:4],
        np.array([depression.id, depression.id]),
    )
    assert np.all(preprocessed.basin_ids[0] == -1)


def test_preprocessed_bowl_can_be_solved_through_public_seam():
    elevations = np.array([
        [0, 0, 0, 0, 0],
        [0, 2, 2, 2, 0],
        [0, 2, 0, 1, 0],
        [0, 2, 2, 2, 0],
        [0, 0, 0, 0, 0],
    ], dtype=np.float32)
    preprocessed = preprocess_dem(elevations, cell_area_m2=1.0)

    result = preprocessed.network.solve(effective_rainfall_depth_m=0.5)

    assert result.input_volume_m3 == pytest.approx(12.5)
    assert result.retained_volume_m3 == pytest.approx(0.5)
    assert result.outflow_volume_m3 == pytest.approx(12.0)
    assert result.mass_balance_error_m3 == pytest.approx(0.0, abs=1.0e-12)


def test_streaming_writer_produces_a_valid_maximum_depth_cog(tmp_path):
    elevations = np.array([
        [0, 0, 0, 0, 0],
        [0, 2, 2, 2, 0],
        [0, 2, 0, 1, 0],
        [0, 2, 2, 2, 0],
        [0, 0, 0, 0, 0],
    ], dtype=np.float32)
    transform = Affine.translation(100.0, 200.0) * Affine.scale(5.0, -5.0)
    dem_path = tmp_path / "dem.tif"
    with rasterio.open(
        dem_path,
        "w",
        driver="GTiff",
        width=5,
        height=5,
        count=1,
        dtype="float32",
        crs="EPSG:32651",
        transform=transform,
        nodata=-9999.0,
    ) as dataset:
        dataset.write(elevations, 1)

    preprocessed = preprocess_dem(elevations, cell_area_m2=25.0)
    result = preprocessed.network.solve(effective_rainfall_depth_m=0.5)
    output_path = tmp_path / "maximum-depth.cog.tif"

    written = write_maximum_depth_cog(
        dem_path=dem_path,
        basin_ids=preprocessed.basin_ids,
        result=result,
        destination=output_path,
    )

    assert written.path == output_path
    assert written.maximum_depth_m == pytest.approx(0.5)
    assert written.wet_area_m2 == pytest.approx(25.0)
    with rasterio.open(output_path) as dataset:
        assert dataset.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
        assert dataset.crs.to_string() == "EPSG:32651"
        assert dataset.transform == transform
        assert dataset.count == 1
        assert dataset.descriptions == ("maximum_water_depth",)
        assert dataset.units == ("m",)
        depths = dataset.read(1)
        assert depths[2, 2] == pytest.approx(0.5)
        assert np.all(depths[elevations > 0] == 0.0)
        assert dataset.tags()["preview_authority"] == "non-authoritative"


def test_local_cli_crops_dem_and_writes_preview_cog(tmp_path, capsys):
    elevations = np.full((7, 7), 9.0, dtype=np.float32)
    elevations[1:6, 1:6] = np.array([
        [0, 0, 0, 0, 0],
        [0, 2, 2, 2, 0],
        [0, 2, 0, 1, 0],
        [0, 2, 2, 2, 0],
        [0, 0, 0, 0, 0],
    ], dtype=np.float32)
    transform = Affine.translation(100.0, 200.0) * Affine.scale(5.0, -5.0)
    dem_path = tmp_path / "source-dem.tif"
    with rasterio.open(
        dem_path,
        "w",
        driver="GTiff",
        width=7,
        height=7,
        count=1,
        dtype="float32",
        crs="EPSG:32651",
        transform=transform,
        nodata=-9999.0,
    ) as dataset:
        dataset.write(elevations, 1)
    output_path = tmp_path / "local-preview.cog.tif"
    cache_path = tmp_path / "preprocessing-cache.npz"

    exit_code = preview_main([
        str(dem_path),
        str(output_path),
        "--effective-rainfall-mm", "500",
        "--window", "1,1,5,5",
        "--preprocessing-cache", str(cache_path),
    ])

    assert exit_code == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["depressionCount"] == 1
    assert summary["maximumDepthM"] == pytest.approx(0.5)
    assert summary["preprocessingCacheReused"] is False
    assert cache_path.exists()
    with rasterio.open(output_path) as dataset:
        assert dataset.shape == (5, 5)
        assert dataset.transform == transform * Affine.translation(1, 1)
        assert dataset.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"

    second_output = tmp_path / "second-preview.cog.tif"
    assert preview_main([
        str(dem_path),
        str(second_output),
        "--effective-rainfall-mm", "250",
        "--window", "1,1,5,5",
        "--preprocessing-cache", str(cache_path),
    ]) == 0
    second_summary = json.loads(capsys.readouterr().out)
    assert second_summary["preprocessingCacheReused"] is True
    assert second_summary["maximumDepthM"] == pytest.approx(0.25)


def test_preprocessing_routes_upslope_rainfall_into_the_pit():
    elevations = np.array([
        [0, 0, 0, 0, 0, 0, 0],
        [0, 1, 1, 1, 1, 1, 0],
        [0, 1, 2, 2, 2, 1, 0],
        [0, 1, 2, 0, 2, 1, 0],
        [0, 1, 2, 2, 2, 1, 0],
        [0, 1, 1, 1, 1, 1, 0],
        [0, 0, 0, 0, 0, 0, 0],
    ], dtype=np.float32)

    preprocessed = preprocess_dem(elevations, cell_area_m2=25.0)

    assert len(preprocessed.depressions) == 1
    assert preprocessed.depressions[0].catchment_area_m2 == pytest.approx(
        9 * 25.0
    )


def test_slope_without_depressions_routes_all_rainfall_to_outlet():
    elevations = np.array([
        [3, 2, 1],
        [3, 2, 1],
        [3, 2, 1],
    ], dtype=np.float32)

    preprocessed = preprocess_dem(elevations, cell_area_m2=25.0)
    result = preprocessed.network.solve(effective_rainfall_depth_m=0.1)

    assert preprocessed.depressions == ()
    assert result.maximum_level_m == {}
    assert result.input_volume_m3 == pytest.approx(22.5)
    assert result.retained_volume_m3 == pytest.approx(0.0)
    assert result.outflow_volume_m3 == pytest.approx(22.5)
    assert result.mass_balance_error_m3 == pytest.approx(0.0, abs=1.0e-12)


def test_hierarchy_does_not_share_water_before_common_saddle():
    hierarchy = DepressionHierarchy(
        leaves=(
            Depression(0, (0.0,), 1.0, 10.0),
            Depression(1, (0.0,), 1.0, 1.0),
        ),
        merges=(
            DepressionMerge(2, (0, 1), (0.0, 0.0), 3.0),
        ),
        root_ids=(2,),
        cell_area_m2=1.0,
    )

    result = hierarchy.solve(effective_rainfall_depth_m=0.1)

    assert result.maximum_level_m == {
        0: pytest.approx(1.0),
        1: pytest.approx(0.1),
    }
    assert result.retained_volume_m3 == pytest.approx(1.1)
    assert result.outflow_volume_m3 == pytest.approx(0.0)


def test_hierarchy_merges_water_surfaces_after_both_children_fill():
    hierarchy = DepressionHierarchy(
        leaves=(
            Depression(0, (0.0,), 1.0, 10.0),
            Depression(1, (0.0,), 1.0, 1.0),
        ),
        merges=(
            DepressionMerge(2, (0, 1), (0.0, 0.0), 3.0),
        ),
        root_ids=(2,),
        cell_area_m2=1.0,
    )

    result = hierarchy.solve(effective_rainfall_depth_m=0.2)

    assert result.maximum_level_m == {
        0: pytest.approx(1.1),
        1: pytest.approx(1.1),
    }
    assert result.input_volume_m3 == pytest.approx(2.2)
    assert result.retained_volume_m3 == pytest.approx(2.2)
    assert result.outflow_volume_m3 == pytest.approx(0.0)
    assert result.mass_balance_error_m3 == pytest.approx(0.0, abs=1.0e-12)


def test_preprocessor_builds_and_caches_a_two_pit_merge_hierarchy(tmp_path):
    elevations = np.array([
        [0, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, 2, 2, 2, 2, 2, 2, 2, 0],
        [0, 2, 2, 2, 2, 2, 2, 2, 0],
        [0, 2, 0, 1, 1, 1, 0, 2, 0],
        [0, 2, 2, 2, 2, 2, 2, 2, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0],
    ], dtype=np.float32)

    preprocessed = preprocess_dem(elevations, cell_area_m2=1.0)

    assert len(preprocessed.depressions) == 2
    assert len(preprocessed.merges) == 1
    assert [item.spill_elevation_m for item in preprocessed.depressions] == [
        pytest.approx(1.0),
        pytest.approx(1.0),
    ]
    assert preprocessed.merges[0].spill_elevation_m == pytest.approx(2.0)
    before_merge = preprocessed.network.solve(
        effective_rainfall_depth_m=0.2
    )
    assert before_merge.maximum_level_m == {
        0: pytest.approx(0.8),
        1: pytest.approx(0.2),
    }
    after_merge = preprocessed.network.solve(
        effective_rainfall_depth_m=0.5
    )
    assert after_merge.maximum_level_m == {
        0: pytest.approx(1.1),
        1: pytest.approx(1.1),
    }

    cache_path = tmp_path / "two-pit.npz"
    save_preprocessed(cache_path, preprocessed, identity="two-pit-v1")
    cached = load_preprocessed(cache_path, expected_identity="two-pit-v1")

    assert len(cached.merges) == 1
    cached_result = cached.network.solve(effective_rainfall_depth_m=0.5)
    assert cached_result.maximum_level_m == after_merge.maximum_level_m
    assert cached_result.mass_balance_error_m3 == pytest.approx(
        0.0,
        abs=1.0e-12,
    )
