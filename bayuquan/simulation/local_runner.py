"""ANUGA runtime for immutable local simulation areas."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
import rasterio

import anuga

from .area_catalog import SimulationAreaCatalog
from .runner import PreparedSimulation, apply_initial_water_levels
from .spec import ScenarioSpec


@dataclass(frozen=True)
class LocalSimulation:
    prepared: PreparedSimulation
    triangle_cell_index: np.ndarray
    area_hash: str


def prepare_local_simulation(
    spec: ScenarioSpec,
    area_hash: str,
    catalog: SimulationAreaCatalog,
    model_inputs_path: str,
    output_dir: Path | str,
) -> LocalSimulation:
    """Load a cached local mesh and assign cell-aligned model quantities."""
    area = catalog.area(area_hash)
    with np.load(catalog.mesh_path(area_hash), allow_pickle=False) as mesh:
        coordinates = mesh["coordinates"]
        triangles = mesh["triangles"]
        triangle_cells = mesh["triangle_cell_index"].astype(np.int64)
        origin = mesh["origin"]
        boundary = {
            (int(triangle), int(edge)): "open"
            for triangle, edge in zip(
                mesh["boundary_triangle"], mesh["boundary_edge"]
            )
        }
    domain = anuga.Domain(
        coordinates,
        triangles,
        boundary,
        geo_reference=anuga.Geo_reference(
            epsg=32651,
            xllcorner=float(origin[0]),
            yllcorner=float(origin[1]),
        ),
        verbose=False,
    )
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    domain.set_flow_algorithm("DE0")
    domain.set_name("model")
    domain.set_datadir(str(output))
    domain.set_quantities_to_be_stored({
        "elevation": 1,
        "stage": 2,
        "xmomentum": 2,
        "ymomentum": 2,
    })

    elevation, friction = _triangle_model_values(
        area,
        triangle_cells,
        catalog.dem_path,
        model_inputs_path,
        spec.friction_scenario,
    )
    domain.set_quantity(
        "elevation",
        np.repeat(elevation[:, None], 3, axis=1),
        location="vertices",
    )
    domain.set_quantity("friction", friction, location="centroids")
    domain.set_quantity("stage", expression="elevation")
    domain.set_quantity("xmomentum", 0.0)
    domain.set_quantity("ymomentum", 0.0)

    initial_volume = apply_initial_water_levels(domain, spec)
    domain.set_boundary({"open": anuga.Transmissive_boundary(domain)})
    operators = {}
    for inlet in spec.inlets:
        region = anuga.Region(domain, indices=inlet.selection.triangle_ids)
        operators[inlet.id] = anuga.Inlet_operator(
            domain,
            region=region,
            Q=inlet.discharge_m3s,
            velocity=inlet.velocity,
            zero_velocity=inlet.zero_velocity,
            label=inlet.id,
        )
    return LocalSimulation(
        prepared=PreparedSimulation(domain, operators, initial_volume),
        triangle_cell_index=triangle_cells,
        area_hash=area_hash,
    )


def run_local_simulation(
    spec: ScenarioSpec,
    area_hash: str,
    catalog: SimulationAreaCatalog,
    model_inputs_path: str,
    output_dir: Path | str,
    *,
    frame_sink: Callable[[object, float, int], None] | None = None,
    progress_sink: Callable[[float, int], None] | None = None,
) -> dict:
    """Execute one local-area scenario and return its hydraulic report."""
    started = time.monotonic()
    area = catalog.area(area_hash)
    local = prepare_local_simulation(
        spec, area_hash, catalog, model_inputs_path, output_dir
    )
    prepared = local.prepared
    domain = prepared.domain
    maximum_depth = np.zeros(len(domain.areas), dtype=float)
    maximum_speed = 0.0
    ever_wet = np.zeros(len(domain.areas), dtype=bool)
    last_time = -1.0

    for frame_index, simulation_time in enumerate(domain.evolve(
        yieldstep=spec.yieldstep_seconds,
        finaltime=spec.duration_seconds,
    )):
        if simulation_time <= last_time:
            raise RuntimeError("ANUGA emitted non-increasing frame times")
        last_time = float(simulation_time)
        stage = domain.quantities["stage"].centroid_values
        elevation = domain.quantities["elevation"].centroid_values
        depth = np.maximum(stage - elevation, 0.0)
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
        if not np.all(np.isfinite(depth)) or not np.all(np.isfinite(speed)):
            raise RuntimeError("simulation produced non-finite output")
        maximum_depth = np.maximum(maximum_depth, depth)
        maximum_speed = max(maximum_speed, float(speed.max()))
        ever_wet |= depth >= 0.01
        if frame_sink is not None:
            frame_sink(domain, float(simulation_time), frame_index)
        if progress_sink is not None:
            progress_sink(float(simulation_time), frame_index)

    if not np.isclose(last_time, spec.duration_seconds):
        raise RuntimeError("ANUGA final frame does not equal scenario duration")
    final_volume = float(domain.get_water_volume())
    applied_volume = sum(
        float(operator.total_applied_volume)
        for operator in prepared.operators.values()
    )
    report = {
        "scenario": spec.name,
        "crs": "EPSG:32651",
        "simulationAreaId": area_hash,
        "datasetVersion": area.dataset_version,
        "durationSeconds": spec.duration_seconds,
        "yieldstepSeconds": spec.yieldstep_seconds,
        "frameCount": spec.frame_count,
        "frictionScenario": spec.friction_scenario,
        "boundaryCondition": "transmissive",
        "initialWaterVolumeM3": prepared.initial_water_volume_m3,
        "requestedInputVolumeM3": (
            spec.total_discharge_m3s * spec.duration_seconds
        ),
        "appliedInputVolumeM3": applied_volume,
        "finalDomainWaterVolumeM3": final_volume,
        "inferredBoundaryOutflowM3": (
            prepared.initial_water_volume_m3 + applied_volume - final_volume
        ),
        "maximumDepthM": float(maximum_depth.max()),
        "maximumSpeedMps": maximum_speed,
        "everWetAreaM2": float(domain.areas[ever_wet].sum()),
        "runtimeSeconds": time.monotonic() - started,
    }
    output = Path(output_dir)
    (output / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    )
    return report


def _triangle_model_values(
    area,
    triangle_cells: np.ndarray,
    dem_path: str,
    model_inputs_path: str,
    friction_scenario: str,
) -> tuple[np.ndarray, np.ndarray]:
    row_start, row_stop, column_start, column_stop = area.window
    window = rasterio.windows.Window(
        column_start,
        row_start,
        column_stop - column_start,
        row_stop - row_start,
    )
    with rasterio.open(dem_path) as dem:
        elevation_window = dem.read(1, window=window)
    friction_band = {"low": 3, "middle": 4, "high": 5}[friction_scenario]
    with rasterio.open(model_inputs_path) as model_inputs:
        friction_window = model_inputs.read(friction_band, window=window)
    rows, columns = np.divmod(triangle_cells, area.ncols)
    local_rows = rows - row_start
    local_columns = columns - column_start
    elevation = elevation_window[local_rows, local_columns].astype(float)
    friction = friction_window[local_rows, local_columns].astype(float)
    if not np.all(np.isfinite(elevation)) or not np.all(np.isfinite(friction)):
        raise ValueError("local model quantities contain non-finite values")
    return elevation, friction
