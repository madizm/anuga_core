"""ANUGA runtime for immutable local simulation areas."""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
import rasterio

import anuga
from anuga.structures.boyd_box_operator import Boyd_box_operator
from anuga.structures.boyd_pipe_operator import Boyd_pipe_operator
from anuga.structures.weir_orifice_trapezoid_operator import (
    Weir_orifice_trapezoid_operator,
)

from .area_catalog import SimulationAreaCatalog
from .feature_compiler import (
    CompiledFeatures,
    apply_feature_quantities,
    compile_features,
    create_feature_domain,
    install_riverwalls,
    triangle_cell_indices,
)
from .runner import PreparedSimulation, install_rainfall_operator, rainfall_report
from .spec import ScenarioSpec


@dataclass(frozen=True)
class LocalSimulation:
    prepared: PreparedSimulation
    triangle_cell_index: np.ndarray
    area_hash: str
    compiled_features: CompiledFeatures
    mesh_sha256: str


def prepare_local_simulation(
    spec: ScenarioSpec,
    area_hash: str,
    catalog: SimulationAreaCatalog,
    model_inputs_path: str,
    output_dir: Path | str,
) -> LocalSimulation:
    """Compile features, construct a domain, and install all operators."""
    area = catalog.area(area_hash)
    compiled = compile_features(
        spec.hydraulic_features, area, str(catalog.dem_path)
    )
    if spec.hydraulic_features.requires_custom_mesh:
        domain = create_feature_domain(area, compiled)
        triangle_cells = triangle_cell_indices(domain, area)
    else:
        domain, triangle_cells = _load_cached_domain(
            catalog.mesh_path(area_hash)
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

    if spec.hydraulic_features.requires_custom_mesh:
        apply_feature_quantities(
            domain,
            compiled,
            str(catalog.dem_path),
            model_inputs_path,
            spec.friction_scenario,
        )
    else:
        elevation, friction = _triangle_model_values(
            area,
            triangle_cells,
            str(catalog.dem_path),
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

    inlet_triangles = _inlet_triangle_indices(
        spec, triangle_cells, area.ncols
    )
    initial_volume = _apply_initial_water_levels(
        domain, spec, inlet_triangles
    )
    domain.set_boundary({"open": anuga.Transmissive_boundary(domain)})
    install_riverwalls(domain, compiled)

    operators = {}
    for inlet in spec.inlets:
        triangle_ids = inlet_triangles[inlet.id]
        if not len(triangle_ids):
            raise ValueError(
                f"inlet {inlet.id} has no triangles in the compiled mesh"
            )
        region = anuga.Region(domain, indices=triangle_ids)
        operators[inlet.id] = anuga.Inlet_operator(
            domain,
            region=region,
            Q=inlet.discharge_m3s,
            velocity=inlet.velocity,
            zero_velocity=inlet.zero_velocity,
            label=inlet.id,
        )
    structure_operators = _install_structure_operators(
        domain, spec, compiled
    )
    rainfall_area = float(domain.areas.sum())
    rainfall_operator = install_rainfall_operator(domain, spec)
    mesh_sha256 = _domain_mesh_sha256(domain)
    setattr(domain, "bayuquan_triangle_cell_index", triangle_cells)
    return LocalSimulation(
        prepared=PreparedSimulation(
            domain,
            operators,
            rainfall_operator,
            structure_operators,
            initial_volume,
            rainfall_area,
        ),
        triangle_cell_index=triangle_cells,
        area_hash=area_hash,
        compiled_features=compiled,
        mesh_sha256=mesh_sha256,
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
    prepared_sink: Callable[[LocalSimulation], None] | None = None,
) -> dict:
    """Execute one local-area scenario and return its hydraulic report."""
    started = time.monotonic()
    area = catalog.area(area_hash)
    local = prepare_local_simulation(
        spec, area_hash, catalog, model_inputs_path, output_dir
    )
    if prepared_sink is not None:
        prepared_sink(local)
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
        raise RuntimeError(
            "ANUGA final frame does not equal scenario duration")
    final_volume = float(domain.get_water_volume())
    rain = rainfall_report(
        spec, prepared.rainfall_area_m2, prepared.rainfall_operator
    )
    applied_volume = rain["appliedVolumeM3"] + sum(
        float(operator.total_applied_volume)
        for operator in prepared.operators.values()
    )
    report = {
        "scenario": spec.name,
        "crs": "EPSG:32651",
        "simulationAreaId": area_hash,
        "datasetVersion": area.dataset_version,
        "meshSha256": local.mesh_sha256,
        "meshTriangleCount": len(domain.areas),
        "openmpThreads": int(domain.omp_num_threads),
        "durationSeconds": spec.duration_seconds,
        "yieldstepSeconds": spec.yieldstep_seconds,
        "frameCount": spec.frame_count,
        "frictionScenario": spec.friction_scenario,
        "boundaryCondition": "transmissive",
        "initialWaterVolumeM3": prepared.initial_water_volume_m3,
        "requestedInputVolumeM3": (
            spec.total_discharge_m3s * spec.duration_seconds
            + rain["requestedVolumeM3"]
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
        "rainfall": rain,
        "hydraulicFeatures": _hydraulic_feature_report(spec, local),
    }
    output = Path(output_dir)
    (output / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    )
    return report


def _load_cached_domain(mesh_path):
    with np.load(mesh_path, allow_pickle=False) as mesh:
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
    return domain, triangle_cells


def _inlet_triangle_indices(spec, triangle_cells, ncols):
    result = {}
    for inlet in spec.inlets:
        selected = {
            int(cell_id.split("-c", 1)[0][1:]) * ncols
            + int(cell_id.split("-c", 1)[1])
            for cell_id in inlet.cell_ids
        }
        result[inlet.id] = np.flatnonzero(
            np.isin(triangle_cells, list(selected))
        ).astype(np.int32)
    return result


def _apply_initial_water_levels(domain, spec, inlet_triangles) -> float:
    stage = domain.quantities["stage"]
    elevation = domain.quantities["elevation"]
    for inlet in spec.inlets:
        if inlet.initial_water_level_m is None:
            continue
        indices = inlet_triangles[inlet.id]
        values = np.maximum(
            elevation.vertex_values[indices], inlet.initial_water_level_m
        )
        stage.set_values(values, location="vertices", indices=indices)
    return float(domain.get_water_volume())


def _install_structure_operators(domain, spec, compiled):
    operators = {}
    for culvert in spec.hydraulic_features.culverts:
        common = {
            "domain": domain,
            "losses": culvert.losses,
            "barrels": culvert.barrels,
            "blockage": culvert.blockage,
            "end_points": [
                list(point)
                for point in compiled.projected_structures[culvert.id]
            ],
            "invert_elevations": (
                None if culvert.invert_elevations_m is None
                else list(culvert.invert_elevations_m)
            ),
            "manning": culvert.manning_n,
            "label": culvert.id,
            "description": culvert.name,
            "verbose": False,
        }
        if culvert.shape == "box":
            operators[culvert.id] = Boyd_box_operator(
                width=culvert.width_m,
                height=culvert.height_m,
                **common,
            )
        else:
            operators[culvert.id] = Boyd_pipe_operator(
                diameter=culvert.diameter_m,
                **common,
            )
    for bridge in spec.hydraulic_features.bridges:
        operators[bridge.id] = Weir_orifice_trapezoid_operator(
            domain,
            losses=bridge.losses,
            width=bridge.width_m,
            height=bridge.height_m,
            blockage=bridge.blockage,
            z1=bridge.left_side_slope,
            z2=bridge.right_side_slope,
            end_points=[
                list(point)
                for point in compiled.projected_structures[bridge.id]
            ],
            invert_elevations=(
                None if bridge.invert_elevations_m is None
                else list(bridge.invert_elevations_m)
            ),
            manning=bridge.manning_n,
            label=bridge.id,
            description=bridge.name,
            verbose=False,
        )
    return operators


def _hydraulic_feature_report(spec, local):
    operators = local.prepared.structure_operators
    return {
        "levees": [
            {
                "id": levee.id,
                "vertexCount": len(levee.points_xyz),
                "lengthM": float(sum(
                    np.hypot(b[0] - a[0], b[1] - a[1])
                    for a, b in zip(levee.points_xyz, levee.points_xyz[1:])
                )),
                "minimumCrestElevationM": min(
                    point[2] for point in levee.points_xyz
                ),
                "maximumCrestElevationM": max(
                    point[2] for point in levee.points_xyz
                ),
                "minimumFreeboardM": levee.minimum_freeboard_m,
            }
            for levee in local.compiled_features.levees
        ],
        "simpleChannels": [
            {
                "id": channel.spec.id,
                "areaM2": channel.polygon.area,
                "manningN": channel.spec.manning_n,
            }
            for channel in local.compiled_features.simple_channels
        ],
        "engineeringChannels": [
            {
                "id": channel.spec.id,
                "lengthM": channel.centerline.length,
                "crossSectionCount": len(channel.spec.cross_sections),
                "manningN": channel.spec.manning_n,
            }
            for channel in local.compiled_features.engineering_channels
        ],
        "structures": [
            {
                "id": feature.id,
                "type": type(feature).__name__.removesuffix("Spec"),
                "accumulatedFlowM3": float(
                    operators[feature.id].accumulated_flow
                ),
                "finalDischargeM3s": float(operators[feature.id].discharge),
            }
            for feature in (
                *spec.hydraulic_features.culverts,
                *spec.hydraulic_features.bridges,
            )
        ],
        "breaches": [
            {
                "id": breach.id,
                "leveeId": breach.levee_id,
                "widthM": breach.width_m,
                "crestElevationM": breach.crest_elevation_m,
            }
            for breach in spec.hydraulic_features.breaches
        ],
    }


def _domain_mesh_sha256(domain) -> str:
    digest = hashlib.sha256()
    digest.update(np.asarray(domain.nodes, dtype=np.float64).tobytes())
    digest.update(np.asarray(domain.triangles, dtype=np.int32).tobytes())
    return digest.hexdigest()


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
