"""ANUGA runtime for immutable, multi-inlet Bayuquan scenarios."""

from __future__ import annotations

import json
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np

import anuga

from .fixed_model import AsciiGrid, FixedModelPaths
from .grid_mapping import GridTriangleMapping
from .spec import ScenarioSpec


@dataclass
class PreparedSimulation:
    domain: object
    operators: dict[str, object]
    initial_water_volume_m3: float


def apply_initial_water_levels(domain, spec: ScenarioSpec) -> float:
    """Apply inlet levels to both vertex and derived centroid stage values."""
    stage = domain.quantities["stage"]
    elevation = domain.quantities["elevation"]
    for inlet in spec.inlets:
        level = inlet.initial_water_level_m
        if level is None:
            continue
        indices = inlet.selection.triangle_ids
        values = np.maximum(elevation.vertex_values[indices], level)
        stage.set_values(values, location="vertices", indices=indices)
    return float(domain.get_water_volume())


def prepare_simulation(
    spec: ScenarioSpec,
    paths: FixedModelPaths,
    output_dir: Path | str,
) -> PreparedSimulation:
    """Load assets, initialize quantities, and install inlet operators."""
    mapping = GridTriangleMapping.load(paths.mapping)
    domain = anuga.Domain(str(paths.mesh), use_cache=False, verbose=False)
    mapping.validate_mesh(paths.mesh, len(domain.areas))

    # The legacy MSH format does not persist complete CRS metadata. Preserve
    # its local origin while explicitly attaching the fixed model CRS.
    if getattr(domain.geo_reference, "epsg", None) is None:
        domain.geo_reference.epsg = 32651
    if domain.geo_reference.epsg != 32651:
        raise ValueError(
            "fixed mesh CRS must be EPSG:32651, "
            f"got {domain.geo_reference.epsg!r}"
        )
    if domain.geo_reference.hemisphere != "northern":
        raise ValueError("fixed mesh must use the northern hemisphere")

    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    domain.set_flow_algorithm("DE0")
    domain.set_name("model")
    domain.set_datadir(str(output))
    domain.set_quantities_to_be_stored(
        {"elevation": 1, "stage": 2, "xmomentum": 2, "ymomentum": 2}
    )

    elevation = AsciiGrid(paths.elevation)
    friction = AsciiGrid(paths.friction(spec.friction_scenario))
    elevation.validate_mapping(mapping, "elevation")
    friction.validate_mapping(mapping, "friction")
    domain.set_quantity("elevation", elevation.sampler(domain))
    domain.set_quantity("friction", friction.sampler(domain))
    domain.set_quantity("stage", expression="elevation")
    domain.set_quantity("xmomentum", 0.0)
    domain.set_quantity("ymomentum", 0.0)

    initial_volume = apply_initial_water_levels(domain, spec)
    domain.set_boundary({"open": anuga.Transmissive_boundary(domain)})

    operators = {}
    for inlet in spec.inlets:
        region = anuga.Region(domain, indices=inlet.selection.triangle_ids)
        if float(domain.areas[inlet.selection.triangle_ids].sum()) <= 0:
            raise ValueError(
                f"inlet {inlet.id} has no effective hydraulic area")
        operators[inlet.id] = anuga.Inlet_operator(
            domain,
            region=region,
            Q=inlet.discharge_m3s,
            velocity=inlet.velocity,
            zero_velocity=inlet.zero_velocity,
            label=inlet.id,
        )
    return PreparedSimulation(domain, operators, initial_volume)


def run_simulation(
    spec: ScenarioSpec,
    paths: FixedModelPaths,
    output_dir: Path | str,
    *,
    frame_sink: Callable[[object, float, int], None] | None = None,
    progress_sink: Callable[[float, int], None] | None = None,
) -> dict:
    """Execute a scenario and return its water-volume and hazard report."""
    started = time.monotonic()
    prepared = prepare_simulation(spec, paths, output_dir)
    domain = prepared.domain
    maximum_depth = np.zeros(len(domain.areas), dtype=float)
    maximum_speed = 0.0
    ever_wet = np.zeros(len(domain.areas), dtype=bool)
    last_time = -1.0

    for frame_index, simulation_time in enumerate(
        domain.evolve(
            yieldstep=spec.yieldstep_seconds,
            finaltime=spec.duration_seconds,
        )
    ):
        if simulation_time <= last_time:
            raise RuntimeError("ANUGA emitted non-increasing frame times")
        last_time = float(simulation_time)
        stage = domain.quantities["stage"].centroid_values
        elevation = domain.quantities["elevation"].centroid_values
        depth = np.maximum(stage - elevation, 0.0)
        if not np.all(np.isfinite(depth)):
            raise RuntimeError("simulation produced non-finite water depth")
        momentum = np.hypot(
            domain.quantities["xmomentum"].centroid_values,
            domain.quantities["ymomentum"].centroid_values,
        )
        speed = np.divide(
            momentum,
            depth,
            out=np.zeros_like(momentum),
            where=depth >= 0.01,
        )
        if not np.all(np.isfinite(speed)):
            raise RuntimeError("simulation produced non-finite speed")
        maximum_depth = np.maximum(maximum_depth, depth)
        maximum_speed = max(maximum_speed, float(speed.max()))
        ever_wet |= depth >= 0.01
        if frame_sink is not None:
            frame_sink(domain, float(simulation_time), frame_index)
        if progress_sink is not None:
            progress_sink(float(simulation_time), frame_index)

    if not np.isclose(last_time, spec.duration_seconds):
        raise RuntimeError(
            f"final frame time {last_time} does not equal "
            f"{spec.duration_seconds}"
        )
    final_volume = float(domain.get_water_volume())
    requested_volume = spec.total_discharge_m3s * spec.duration_seconds
    applied_volume = sum(
        float(operator.total_applied_volume)
        for operator in prepared.operators.values()
    )
    report = {
        "scenario": spec.name,
        "crs": "EPSG:32651",
        "meshSha256": GridTriangleMapping.file_sha256(paths.mesh),
        "durationSeconds": spec.duration_seconds,
        "yieldstepSeconds": spec.yieldstep_seconds,
        "frameCount": spec.frame_count,
        "frictionScenario": spec.friction_scenario,
        "boundaryCondition": "transmissive",
        "initialWaterVolumeM3": prepared.initial_water_volume_m3,
        "requestedInputVolumeM3": requested_volume,
        "appliedInputVolumeM3": applied_volume,
        "finalDomainWaterVolumeM3": final_volume,
        "inferredBoundaryOutflowM3": (
            prepared.initial_water_volume_m3 + applied_volume - final_volume
        ),
        "maximumDepthM": float(maximum_depth.max()),
        "maximumSpeedMps": maximum_speed,
        "everWetAreaM2": float(domain.areas[ever_wet].sum()),
        "runtimeSeconds": time.monotonic() - started,
        "inlets": [
            {
                "id": inlet.id,
                "cellIds": list(inlet.cell_ids),
                "triangleCount": len(inlet.selection.triangle_ids),
                "geometricAreaM2": inlet.selection.geometric_area_m2,
                "effectiveHydraulicAreaM2": (
                    inlet.selection.effective_triangle_area_m2
                ),
                "dischargeM3s": inlet.discharge_m3s,
                "requestedVolumeM3": (
                    inlet.discharge_m3s * spec.duration_seconds
                ),
                "appliedVolumeM3": float(
                    prepared.operators[inlet.id].total_applied_volume
                ),
            }
            for inlet in spec.inlets
        ],
    }
    output = Path(output_dir)
    (output / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    )
    return report


def snapshot_scenario(source: Path | str, output_dir: Path | str) -> Path:
    """Copy the exact submitted JSON beside simulation artifacts."""
    target = Path(output_dir) / "scenario.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    return target
