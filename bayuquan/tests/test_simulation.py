from __future__ import annotations

import hashlib

import numpy as np
import pytest

from bayuquan.simulation.grid_mapping import (
    GridMappingError,
    GridTriangleMapping,
)
from bayuquan.simulation.spec import ScenarioSpec, ScenarioValidationError


def mapping():
    return GridTriangleMapping(
        triangle_cell_index=np.array([0, 1, 1, 2, 4], dtype=np.int32),
        triangle_area_m2=np.array([400, 300, 350, 450, 200], dtype=float),
        nrows=2,
        ncols=3,
        cellsize=30,
        xllcorner=100,
        yllcorner=200,
        mesh_sha256="unused",
    )


def inlet(inlet_id="a", cells=None, **overrides):
    result = {
        "id": inlet_id,
        "name": inlet_id,
        "enabled": True,
        "cellIds": cells or ["r0000-c0000", "r0000-c0001"],
        "dischargeM3s": 10,
        "velocityMode": "zero",
        "initialWaterLevelM": None,
    }
    result.update(overrides)
    return result


def scenario(*inlets):
    return {
        "name": "test",
        "durationSeconds": 60,
        "yieldstepSeconds": 10,
        "frictionScenario": "middle",
        "inlets": list(inlets),
    }


def test_resolve_returns_normalized_cells_and_all_mapped_triangles():
    selection = mapping().resolve(["r0000-c0001", "r0000-c0000"])

    assert selection.cell_ids == ("r0000-c0000", "r0000-c0001")
    np.testing.assert_array_equal(selection.triangle_ids, [0, 1, 2])
    assert selection.geometric_area_m2 == 1800
    assert selection.effective_triangle_area_m2 == 1050
    assert not selection.triangle_ids.flags.writeable


def test_resolve_accepts_five_digit_grid_indices():
    large_mapping = GridTriangleMapping(
        triangle_cell_index=np.array([10_000, 10_001], dtype=np.int32),
        triangle_area_m2=np.array([50, 50], dtype=float),
        nrows=1,
        ncols=10_002,
        cellsize=10,
        xllcorner=100,
        yllcorner=200,
        mesh_sha256="unused",
    )

    selection = large_mapping.resolve([
        "r0000-c10000", "r0000-c10001",
    ])

    assert selection.cell_ids == ("r0000-c10000", "r0000-c10001")


@pytest.mark.parametrize(
    "cells, message",
    [
        ([], "at least one"),
        (["r0000-c0000", "r0000-c0000"], "duplicate"),
        (["r0000-c0000", "r0000-c0002"], "connected"),
        (["r0001-c0000"], "not selectable"),
        (["bad"], "invalid cell ID"),
    ],
)
def test_resolve_rejects_invalid_selections(cells, message):
    with pytest.raises(GridMappingError, match=message):
        mapping().resolve(cells)


def test_scenario_normalizes_bearing_velocity_and_ignores_disabled_inlets():
    data = scenario(
        inlet(
            velocityMode="bearing",
            speedMps=2,
            bearingDegrees=90,
        ),
        inlet("disabled", enabled=False, cells=["r0000-c0002"]),
    )

    spec = ScenarioSpec.from_dict(data, mapping())

    assert len(spec.inlets) == 1
    assert spec.inlets[0].velocity_u_mps == pytest.approx(2)
    assert spec.inlets[0].velocity_v_mps == pytest.approx(0, abs=1e-12)
    assert spec.frame_count == 7
    assert spec.total_discharge_m3s == 10


def test_scenario_rejects_overlapping_enabled_inlets():
    data = scenario(
        inlet("west"),
        inlet("east", ["r0000-c0001", "r0000-c0002"]),
    )

    with pytest.raises(ScenarioValidationError, match="overlap.*r0000-c0001"):
        ScenarioSpec.from_dict(data, mapping())


@pytest.mark.parametrize(
    "change, message",
    [
        ({"durationSeconds": 0}, "durationSeconds"),
        ({"yieldstepSeconds": 61}, "yieldstepSeconds"),
        ({"frictionScenario": "extreme"}, "frictionScenario"),
        ({"inlets": []}, "at least one"),
    ],
)
def test_scenario_rejects_invalid_top_level_values(change, message):
    data = scenario(inlet())
    data.update(change)
    with pytest.raises(ScenarioValidationError, match=message):
        ScenarioSpec.from_dict(data, mapping())


def test_validate_mesh_checks_hash_and_triangle_count(tmp_path):
    mesh = tmp_path / "mesh.msh"
    mesh.write_bytes(b"fixed mesh")
    model = mapping()
    model.mesh_sha256 = hashlib.sha256(mesh.read_bytes()).hexdigest()

    model.validate_mesh(mesh, 5)
    with pytest.raises(GridMappingError, match="triangle count"):
        model.validate_mesh(mesh, 4)
    mesh.write_bytes(b"changed")
    with pytest.raises(GridMappingError, match="SHA-256"):
        model.validate_mesh(mesh, 5)


def rainfall(*points, enabled=True):
    return {
        "enabled": enabled,
        "points": [
            {"timeMinutes": time, "intensityMmPerHour": intensity}
            for time, intensity in points
        ],
    }


def test_rainfall_step_profile_and_cumulative_depth():
    data = scenario()
    data["durationSeconds"] = 3600
    data["yieldstepSeconds"] = 60
    data["rainfall"] = rainfall((0, 0), (10, 30), (40, 10))

    spec = ScenarioSpec.from_dict(data, mapping())

    assert spec.inlets == ()
    assert spec.rainfall.intensity_at(599) == 0
    assert spec.rainfall.intensity_at(600) == 30
    assert spec.rainfall.intensity_at(2400) == 10
    assert spec.rainfall.cumulative_depth_mm(3600) == pytest.approx(18.333333)


def test_single_rainfall_point_defines_constant_rainfall():
    data = scenario()
    data["rainfall"] = rainfall((0, 50))

    spec = ScenarioSpec.from_dict(data, mapping())

    assert spec.rainfall.intensity_at(59) == 50
    assert spec.rainfall.cumulative_depth_mm(60) == pytest.approx(50 / 60)


def test_missing_or_disabled_rainfall_preserves_inlet_scenarios():
    missing = ScenarioSpec.from_dict(scenario(inlet()), mapping())
    disabled_data = scenario(inlet())
    disabled_data["rainfall"] = {
        "enabled": False,
        "points": [{"timeMinutes": "ignored", "intensityMmPerHour": -1}],
    }

    disabled = ScenarioSpec.from_dict(disabled_data, mapping())

    assert not missing.rainfall.enabled
    assert not disabled.rainfall.enabled
    assert disabled.rainfall.points == ()


@pytest.mark.parametrize(
    "profile, message",
    [
        ({"enabled": True, "points": []}, "at least one"),
        (rainfall((1, 10)), "start at 0"),
        (rainfall((0, 10), (0, 20)), "strictly increasing"),
        (rainfall((0, -1)), "must not be negative"),
        (rainfall((0.5, 10)), "whole minute"),
        (rainfall((0, 10), (2, 20)), "within simulation duration"),
    ],
)
def test_enabled_rainfall_is_strictly_validated(profile, message):
    data = scenario()
    data["rainfall"] = profile

    with pytest.raises(ScenarioValidationError, match=message):
        ScenarioSpec.from_dict(data, mapping())


def test_zero_rainfall_without_an_inlet_is_not_an_effective_source():
    data = scenario()
    data["rainfall"] = rainfall((0, 0))

    with pytest.raises(ScenarioValidationError, match="effective water source"):
        ScenarioSpec.from_dict(data, mapping())
