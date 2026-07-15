"""Authoritative scenario validation and transactional persistence."""

from __future__ import annotations

import math

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from bayuquan.simulation.spec import ScenarioSpec, ScenarioValidationError

from ..fixed_model.catalog import FixedModelCatalog
from ..models import Scenario, ScenarioInlet, ScenarioInletCell
from ..schemas import ScenarioRequest


MAX_INLETS = 20
MAX_CELLS_PER_INLET = 500
MAX_TOTAL_DISCHARGE_M3S = 10000.0
MAX_SPEED_MPS = 20.0
MAX_DURATION_SECONDS = 7 * 24 * 3600
MAX_FRAMES = 2000
INITIAL_LEVEL_WARNING_M = 20.0


def validate_scenario(payload: dict, catalog: FixedModelCatalog) -> dict:
    errors = []
    warnings = []
    spec = None
    try:
        spec = ScenarioSpec.from_dict(payload, catalog.mapping)
    except ScenarioValidationError as error:
        errors.append({"code": "INVALID_SCENARIO", "message": str(error)})

    enabled = [item for item in payload.get("inlets", [])
               if item.get("enabled", True)]
    if len(enabled) > MAX_INLETS:
        errors.append({"code": "TOO_MANY_INLETS",
                       "message": f"at most {MAX_INLETS} inlets are allowed"})
    for inlet in enabled:
        inlet_id = inlet.get("id", "unknown")
        if len(inlet.get("cellIds", [])) > MAX_CELLS_PER_INLET:
            errors.append({
                "code": "TOO_MANY_INLET_CELLS",
                "message": (
                    f"{inlet_id} exceeds {MAX_CELLS_PER_INLET} cells"
                ),
            })
        level = inlet.get("initialWaterLevelM")
        if level is not None:
            elevations = [
                float(catalog.cells[cell]["elevation_m"])
                for cell in inlet.get("cellIds", [])
                if cell in catalog.cells
            ]
            excessive_level = (
                elevations
                and level - min(elevations) > INITIAL_LEVEL_WARNING_M
            )
            if excessive_level:
                warnings.append({
                    "code": "HIGH_INITIAL_WATER_LEVEL",
                    "message": (
                        f"{inlet_id} initial level is more than "
                        f"{INITIAL_LEVEL_WARNING_M:g} m above terrain"
                    ),
                })

    if spec is not None:
        speeds = [math.hypot(inlet.velocity_u_mps, inlet.velocity_v_mps)
                  for inlet in spec.inlets]
        if spec.total_discharge_m3s > MAX_TOTAL_DISCHARGE_M3S:
            errors.append({
                "code": "TOTAL_DISCHARGE_LIMIT",
                "message": (
                    f"total discharge exceeds {MAX_TOTAL_DISCHARGE_M3S:g} m3/s"
                ),
            })
        if speeds and max(speeds) > MAX_SPEED_MPS:
            errors.append({"code": "SPEED_LIMIT",
                           "message": f"speed exceeds {MAX_SPEED_MPS:g} m/s"})
        if spec.duration_seconds > MAX_DURATION_SECONDS:
            errors.append({"code": "DURATION_LIMIT",
                           "message": "simulation duration exceeds limit"})
        if spec.frame_count > MAX_FRAMES:
            errors.append({"code": "FRAME_LIMIT",
                           "message": f"output exceeds {MAX_FRAMES} frames"})

    summary = None if spec is None else {
        "enabledInletCount": len(spec.inlets),
        "totalDischargeM3s": spec.total_discharge_m3s,
        "totalInputVolumeM3": (
            spec.total_discharge_m3s * spec.duration_seconds
        ),
        "frameCount": spec.frame_count,
        "fixedModelVersion": catalog.version_id,
        "boundaryCondition": "transmissive",
    }
    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "summary": summary,
    }


def scenario_query():
    return select(Scenario).options(
        selectinload(Scenario.inlets).selectinload(ScenarioInlet.cells)
    )


def get_scenario(session: Session, scenario_id: str) -> Scenario | None:
    return session.scalar(scenario_query().where(Scenario.id == scenario_id))


def save_scenario(
    session: Session,
    request: ScenarioRequest,
    scenario: Scenario | None = None,
) -> Scenario:
    if scenario is None:
        scenario = Scenario()
        session.add(scenario)
    scenario.name = request.name
    scenario.duration_seconds = request.duration_seconds
    scenario.yieldstep_seconds = request.yieldstep_seconds
    scenario.friction_scenario = request.friction_scenario
    scenario.inlets.clear()
    for order, item in enumerate(request.inlets):
        inlet = ScenarioInlet(
            id=item.id,
            name=item.name or item.id,
            enabled=item.enabled,
            discharge_m3s=item.discharge_m3s,
            velocity_mode=item.velocity_mode,
            velocity_u_mps=item.velocity_u_mps,
            velocity_v_mps=item.velocity_v_mps,
            speed_mps=item.speed_mps,
            bearing_degrees=item.bearing_degrees,
            initial_water_level_m=item.initial_water_level_m,
            display_color=item.display_color,
            sort_order=order,
        )
        inlet.cells = [
            ScenarioInletCell(
                scenario_id=scenario.id,
                inlet_id=item.id,
                cell_id=cell_id,
            )
            for cell_id in item.cell_ids
        ]
        scenario.inlets.append(inlet)
    session.flush()
    return scenario


def scenario_snapshot(scenario: Scenario) -> dict:
    inlets = []
    for inlet in scenario.inlets:
        item = {
            "id": inlet.id,
            "name": inlet.name,
            "enabled": inlet.enabled,
            "cellIds": [cell.cell_id for cell in inlet.cells],
            "dischargeM3s": inlet.discharge_m3s,
            "velocityMode": inlet.velocity_mode,
            "initialWaterLevelM": inlet.initial_water_level_m,
            "displayColor": inlet.display_color,
        }
        if inlet.velocity_mode == "components":
            item["velocityUMps"] = inlet.velocity_u_mps
            item["velocityVMps"] = inlet.velocity_v_mps
        elif inlet.velocity_mode == "bearing":
            item["speedMps"] = inlet.speed_mps
            item["bearingDegrees"] = inlet.bearing_degrees
        inlets.append(item)
    return {
        "name": scenario.name,
        "durationSeconds": scenario.duration_seconds,
        "yieldstepSeconds": scenario.yieldstep_seconds,
        "frictionScenario": scenario.friction_scenario,
        "inlets": inlets,
    }


def scenario_response(scenario: Scenario) -> dict:
    result = scenario_snapshot(scenario)
    result.update({
        "id": scenario.id,
        "createdAt": scenario.created_at,
        "updatedAt": scenario.updated_at,
    })
    return result
