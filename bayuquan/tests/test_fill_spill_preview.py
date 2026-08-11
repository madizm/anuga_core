"""Behaviour tests for the experimental fill-spill preview seam."""

import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from affine import Affine
from rasterio.windows import Window

from bayuquan.preview import fill_spill as fill_spill_module
from bayuquan.preview.cache import (
    PreprocessingCacheMismatch,
    load_preprocessed,
    save_preprocessed,
)
from bayuquan.preview.depth_cog import write_maximum_depth_cog
from bayuquan.preview.fill_spill import (
    Depression,
    DepressionHierarchy,
    DepressionMerge,
    DepressionNetwork,
)
from bayuquan.preview.local_preview import (
    main as preview_main,
    run_local_preview,
)
from bayuquan.preview.preprocessing import (
    _watershed_seeds_and_receivers,
    preprocess_dem,
)


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


def test_d8_receiver_uses_steepest_distance_normalised_descent():
    elevations = np.array([
        [8.0, 20.0, 20.0],
        [8.5, 10.0, 20.0],
        [20.0, 20.0, 20.0],
    ])

    _, receivers, _ = _watershed_seeds_and_receivers(
        elevations,
        np.ones(elevations.shape, dtype=bool),
        np.array([
            [True, True, True],
            [True, False, True],
            [True, True, True],
        ]),
    )

    assert receivers[4] == 3


def test_d8_receiver_breaks_equal_slope_ties_by_cell_index():
    elevations = np.array([
        [20.0, 8.0, 20.0],
        [8.0, 10.0, 20.0],
        [20.0, 20.0, 20.0],
    ])
    open_boundary = np.ones(elevations.shape, dtype=bool)
    open_boundary[1, 1] = False

    _, receivers, _ = _watershed_seeds_and_receivers(
        elevations,
        np.ones(elevations.shape, dtype=bool),
        open_boundary,
    )

    assert receivers[4] == 1


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
    assert result.retained_volume_m3 == pytest.approx(1.0)
    assert result.outflow_volume_m3 == pytest.approx(11.5)
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
    assert written.maximum_depth_m == pytest.approx(1.0)
    assert written.wet_area_m2 == pytest.approx(25.0)
    with rasterio.open(output_path) as dataset:
        assert dataset.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
        assert dataset.crs.to_string() == "EPSG:32651"
        assert dataset.transform == transform
        assert dataset.count == 1
        assert dataset.descriptions == ("maximum_water_depth",)
        assert dataset.units == ("m",)
        depths = dataset.read(1)
        assert depths[2, 2] == pytest.approx(1.0)
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
    assert summary["maximumDepthM"] == pytest.approx(1.0)
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
    assert second_summary["maximumDepthM"] == pytest.approx(0.5)

    with np.load(cache_path, allow_pickle=False) as archive:
        contents = {name: archive[name] for name in archive.files}
    contents["root_ids"] = np.array([999], dtype=np.int32)
    np.savez_compressed(cache_path, **contents)
    rebuilt_output = tmp_path / "rebuilt-preview.cog.tif"
    assert preview_main([
        str(dem_path),
        str(rebuilt_output),
        "--effective-rainfall-mm", "125",
        "--window", "1,1,5,5",
        "--preprocessing-cache", str(cache_path),
    ]) == 0
    rebuilt_summary = json.loads(capsys.readouterr().out)
    assert rebuilt_summary["preprocessingCacheReused"] is False
    assert rebuilt_output.exists()

    with cache_path.open("wb") as stream:
        np.save(stream, np.array([1], dtype=np.int8))
    container_output = tmp_path / "container-rebuilt-preview.cog.tif"
    assert preview_main([
        str(dem_path),
        str(container_output),
        "--effective-rainfall-mm", "100",
        "--window", "1,1,5,5",
        "--preprocessing-cache", str(cache_path),
    ]) == 0
    container_summary = json.loads(capsys.readouterr().out)
    assert container_summary["preprocessingCacheReused"] is False
    assert container_output.exists()


def test_local_cli_requires_a_bounded_window(tmp_path):
    output_path = tmp_path / "must-not-exist.tif"

    with pytest.raises(SystemExit) as error:
        preview_main([
            str(tmp_path / "dem.tif"),
            str(output_path),
            "--effective-rainfall-mm", "80",
        ])

    assert error.value.code == 2
    assert not output_path.exists()


def test_real_5m_dem_window_runs_full_preview_e2e(tmp_path):
    dem_path = (
        Path(__file__).resolve().parents[2]
        / "OUTPUT/model/web/elevation_5m_cog.tif"
    )
    if not dem_path.exists():
        pytest.skip(f"real 5 m DEM is unavailable: {dem_path}")

    window = Window(2413, 1779, 64, 64)
    output_path = tmp_path / "real-5m-preview.cog.tif"
    cache_path = tmp_path / "real-5m-preprocessing.npz"
    summary = run_local_preview(
        dem_path=dem_path,
        destination=output_path,
        effective_rainfall_mm=80.0,
        window=window,
        preprocessing_cache=cache_path,
    )

    assert cache_path.exists()
    assert summary.preprocessing_cache_reused is False
    assert summary.input_volume_m3 == pytest.approx(
        summary.retained_volume_m3 + summary.outflow_volume_m3,
        rel=1.0e-10,
        abs=1.0e-8,
    )
    assert summary.mass_balance_error_m3 == pytest.approx(0.0, abs=1.0e-8)
    assert summary.written_cog.maximum_depth_m >= 0.0
    assert summary.written_cog.wet_area_m2 >= 0.0
    assert all(
        area >= 0.0
        for area in summary.written_cog.threshold_areas_m2.values()
    )

    with rasterio.open(dem_path) as source, rasterio.open(output_path) as output:
        assert output.shape == (64, 64)
        assert output.transform == source.window_transform(window)
        assert output.crs == source.crs
        assert output.count == 1
        assert output.dtypes == ("float32",)
        assert output.descriptions == ("maximum_water_depth",)
        assert output.units == ("m",)
        assert output.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
        tags = output.tags()
        assert tags["preview_authority"] == "non-authoritative"
        depths = output.read(1, masked=True)
        assert np.all(np.isfinite(depths.compressed()))
        assert np.all(depths.compressed() >= 0.0)
        assert float(tags["input_volume_m3"]) == pytest.approx(
            summary.input_volume_m3,
            rel=1.0e-8,
        )
        assert float(tags["mass_balance_error_m3"]) == pytest.approx(
            0.0,
            abs=1.0e-8,
        )
        for threshold, area in summary.written_cog.threshold_areas_m2.items():
            key = f"area_ge_{threshold:.2f}_m_m2".replace(".", "_")
            assert float(tags[key]) == pytest.approx(area, rel=1.0e-8)

    cached_output = tmp_path / "real-5m-preview-cached.cog.tif"
    cached_summary = run_local_preview(
        dem_path=dem_path,
        destination=cached_output,
        effective_rainfall_mm=40.0,
        window=window,
        preprocessing_cache=cache_path,
    )
    assert cached_summary.preprocessing_cache_reused is True
    assert cached_summary.mass_balance_error_m3 == pytest.approx(
        0.0,
        abs=1.0e-8,
    )


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


def test_preprocessor_builds_and_caches_a_two_pit_merge_hierarchy(
    tmp_path,
    monkeypatch,
):
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
    curve_calls = 0
    original_init = fill_spill_module._StorageCurve.__init__

    def count_curve_calls(*args, **kwargs):
        nonlocal curve_calls
        curve_calls += 1
        original_init(*args, **kwargs)

    monkeypatch.setattr(
        fill_spill_module._StorageCurve,
        "__init__",
        count_curve_calls,
    )
    cached = load_preprocessed(cache_path, expected_identity="two-pit-v1")

    assert curve_calls == len(preprocessed.depressions) + len(
        preprocessed.merges
    )
    assert len(cached.merges) == 1
    cached_result = cached.network.solve(effective_rainfall_depth_m=0.5)
    assert cached_result.maximum_level_m == after_merge.maximum_level_m
    assert cached_result.mass_balance_error_m3 == pytest.approx(
        0.0,
        abs=1.0e-12,
    )


def test_semantically_corrupt_cache_is_reported_as_a_cache_mismatch(tmp_path):
    elevations = np.array([
        [0, 0, 0, 0, 0],
        [0, 2, 2, 2, 0],
        [0, 2, 0, 1, 0],
        [0, 2, 2, 2, 0],
        [0, 0, 0, 0, 0],
    ], dtype=np.float32)
    cache_path = tmp_path / "corrupt.npz"
    save_preprocessed(
        cache_path,
        preprocess_dem(elevations, cell_area_m2=1.0),
        identity="corrupt-v1",
    )
    with np.load(cache_path, allow_pickle=False) as archive:
        contents = {name: archive[name] for name in archive.files}
    contents["root_ids"] = np.array([999], dtype=np.int32)
    np.savez_compressed(cache_path, **contents)

    with pytest.raises(
        PreprocessingCacheMismatch,
        match="contents are invalid",
    ):
        load_preprocessed(cache_path, expected_identity="corrupt-v1")


def test_lazy_cache_member_failure_is_reported_as_a_cache_mismatch(
    tmp_path,
    monkeypatch,
):
    cache_path = tmp_path / "lazy-failure.npz"
    np.savez(cache_path, schema_version=np.asarray(2, dtype=np.int32))
    original_getitem = np.lib.npyio.NpzFile.__getitem__

    def fail_schema_read(archive, key):
        if key == "schema_version":
            raise EOFError("truncated cache member")
        return original_getitem(archive, key)

    monkeypatch.setattr(
        np.lib.npyio.NpzFile,
        "__getitem__",
        fail_schema_read,
    )

    with pytest.raises(
        PreprocessingCacheMismatch,
        match="cannot read preprocessing cache",
    ):
        load_preprocessed(cache_path, expected_identity="lazy-v1")
