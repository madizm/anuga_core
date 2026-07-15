"""Immutable, JSON-backed simulation specification for the Bayuquan worker."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .grid_mapping import GridSelection, GridTriangleMapping


class ScenarioValidationError(ValueError):
    """Raised when a scenario cannot be executed safely."""


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise ScenarioValidationError(f"{field} must be a finite number")
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ScenarioValidationError(
            f"{field} must be a finite number") from error
    if not math.isfinite(result):
        raise ScenarioValidationError(f"{field} must be a finite number")
    return result


@dataclass(frozen=True)
class InletSpec:
    id: str
    name: str
    cell_ids: tuple[str, ...]
    discharge_m3s: float
    velocity_u_mps: float
    velocity_v_mps: float
    zero_velocity: bool
    initial_water_level_m: float | None
    selection: GridSelection

    @property
    def velocity(self) -> tuple[float, float] | None:
        if self.zero_velocity:
            return None
        return self.velocity_u_mps, self.velocity_v_mps

    @classmethod
    def from_dict(
        cls, data: dict[str, Any], mapping: GridTriangleMapping
    ) -> "InletSpec | None":
        if not isinstance(data, dict):
            raise ScenarioValidationError("each inlet must be an object")
        if not data.get("enabled", True):
            return None

        inlet_id = str(data.get("id", "")).strip()
        if not inlet_id:
            raise ScenarioValidationError("inlet.id is required")
        name = str(data.get("name", inlet_id)).strip() or inlet_id
        raw_cells = data.get("cellIds")
        if not isinstance(raw_cells, list) or not all(
            isinstance(value, str) for value in raw_cells
        ):
            raise ScenarioValidationError(
                f"{inlet_id}.cellIds must be a string array")
        try:
            selection = mapping.resolve(raw_cells)
        except ValueError as error:
            raise ScenarioValidationError(f"{inlet_id}: {error}") from error

        discharge = _finite_number(
            data.get("dischargeM3s"), f"{inlet_id}.dischargeM3s"
        )
        if discharge <= 0:
            raise ScenarioValidationError(
                f"{inlet_id}.dischargeM3s must be greater than zero"
            )

        mode = data.get("velocityMode", "zero")
        if mode == "zero":
            u = v = 0.0
            zero_velocity = True
        elif mode == "components":
            u = _finite_number(data.get("velocityUMps"),
                               f"{inlet_id}.velocityUMps")
            v = _finite_number(data.get("velocityVMps"),
                               f"{inlet_id}.velocityVMps")
            zero_velocity = False
        elif mode == "bearing":
            speed = _finite_number(data.get("speedMps"),
                                   f"{inlet_id}.speedMps")
            bearing = _finite_number(
                data.get("bearingDegrees"), f"{inlet_id}.bearingDegrees"
            )
            if speed < 0:
                raise ScenarioValidationError(
                    f"{inlet_id}.speedMps must not be negative"
                )
            radians = math.radians(bearing)
            u = speed * math.sin(radians)
            v = speed * math.cos(radians)
            zero_velocity = False
        else:
            raise ScenarioValidationError(
                f"{inlet_id}.velocityMode must be zero, components, or bearing"
            )

        raw_level = data.get("initialWaterLevelM")
        initial_level = (
            None
            if raw_level is None
            else _finite_number(raw_level, f"{inlet_id}.initialWaterLevelM")
        )
        return cls(
            id=inlet_id,
            name=name,
            cell_ids=selection.cell_ids,
            discharge_m3s=discharge,
            velocity_u_mps=u,
            velocity_v_mps=v,
            zero_velocity=zero_velocity,
            initial_water_level_m=initial_level,
            selection=selection,
        )


@dataclass(frozen=True)
class ScenarioSpec:
    name: str
    duration_seconds: float
    yieldstep_seconds: float
    friction_scenario: str
    inlets: tuple[InletSpec, ...]

    @property
    def frame_count(self) -> int:
        return math.ceil(self.duration_seconds / self.yieldstep_seconds) + 1

    @property
    def total_discharge_m3s(self) -> float:
        return sum(inlet.discharge_m3s for inlet in self.inlets)

    @classmethod
    def load(
        cls, path: Path | str, mapping: GridTriangleMapping
    ) -> "ScenarioSpec":
        try:
            data = json.loads(Path(path).read_text())
        except (OSError, json.JSONDecodeError) as error:
            raise ScenarioValidationError(
                f"cannot read scenario {path}: {error}") from error
        return cls.from_dict(data, mapping)

    @classmethod
    def from_dict(
        cls, data: dict[str, Any], mapping: GridTriangleMapping
    ) -> "ScenarioSpec":
        if not isinstance(data, dict):
            raise ScenarioValidationError("scenario must be a JSON object")
        name = str(data.get("name", "")).strip()
        if not name:
            raise ScenarioValidationError("scenario.name is required")
        duration = _finite_number(
            data.get("durationSeconds"), "durationSeconds")
        yieldstep = _finite_number(
            data.get("yieldstepSeconds"), "yieldstepSeconds")
        if duration <= 0:
            raise ScenarioValidationError(
                "durationSeconds must be greater than zero")
        if yieldstep <= 0 or yieldstep > duration:
            raise ScenarioValidationError(
                "yieldstepSeconds must be positive and not exceed "
                "durationSeconds"
            )
        if not duration.is_integer() or not yieldstep.is_integer():
            raise ScenarioValidationError(
                "durationSeconds and yieldstepSeconds must be whole seconds"
            )
        friction = data.get("frictionScenario", "middle")
        if friction not in {"low", "middle", "high"}:
            raise ScenarioValidationError(
                "frictionScenario must be low, middle, or high"
            )

        raw_inlets = data.get("inlets")
        if not isinstance(raw_inlets, list):
            raise ScenarioValidationError("inlets must be an array")
        inlets = tuple(
            inlet
            for item in raw_inlets
            if (inlet := InletSpec.from_dict(item, mapping)) is not None
        )
        if not inlets:
            raise ScenarioValidationError(
                "scenario needs at least one enabled inlet")
        ids = [inlet.id for inlet in inlets]
        if len(set(ids)) != len(ids):
            raise ScenarioValidationError("enabled inlet IDs must be unique")

        owners: dict[str, str] = {}
        for inlet in inlets:
            for cell in inlet.cell_ids:
                if cell in owners:
                    raise ScenarioValidationError(
                        f"inlets {owners[cell]} and {inlet.id} "
                        f"overlap at {cell}"
                    )
                owners[cell] = inlet.id

        return cls(
            name=name,
            duration_seconds=duration,
            yieldstep_seconds=yieldstep,
            friction_scenario=friction,
            inlets=inlets,
        )
