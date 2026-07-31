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
class RainfallPointSpec:
    time_minutes: int
    intensity_mm_per_hour: float


@dataclass(frozen=True)
class RainfallSpec:
    enabled: bool
    points: tuple[RainfallPointSpec, ...]

    @classmethod
    def from_dict(
        cls, data: Any, duration_seconds: float
    ) -> "RainfallSpec":
        if data is None:
            return cls(enabled=False, points=())
        if not isinstance(data, dict):
            raise ScenarioValidationError("rainfall must be an object")
        enabled = data.get("enabled", False)
        if not isinstance(enabled, bool):
            raise ScenarioValidationError("rainfall.enabled must be a boolean")
        raw_points = data.get("points", [])
        if not isinstance(raw_points, list):
            raise ScenarioValidationError("rainfall.points must be an array")
        if not enabled:
            return cls(enabled=False, points=())
        if not raw_points:
            raise ScenarioValidationError(
                "enabled rainfall needs at least one point"
            )

        points = []
        previous_time = -1
        for index, item in enumerate(raw_points):
            field = f"rainfall.points[{index}]"
            if not isinstance(item, dict):
                raise ScenarioValidationError(f"{field} must be an object")
            raw_time = item.get("timeMinutes")
            if isinstance(raw_time, bool) or not isinstance(raw_time, int):
                raise ScenarioValidationError(
                    f"{field}.timeMinutes must be a whole minute"
                )
            if raw_time < 0 or raw_time * 60 > duration_seconds:
                raise ScenarioValidationError(
                    f"{field}.timeMinutes must be within simulation duration"
                )
            if raw_time <= previous_time:
                raise ScenarioValidationError(
                    "rainfall point times must be strictly increasing"
                )
            intensity = _finite_number(
                item.get("intensityMmPerHour"),
                f"{field}.intensityMmPerHour",
            )
            if intensity < 0:
                raise ScenarioValidationError(
                    f"{field}.intensityMmPerHour must not be negative"
                )
            points.append(RainfallPointSpec(raw_time, intensity))
            previous_time = raw_time
        if points[0].time_minutes != 0:
            raise ScenarioValidationError(
                "the first rainfall point must start at 0 minutes"
            )
        return cls(enabled=True, points=tuple(points))

    def intensity_at(self, time_seconds: float) -> float:
        """Return the right-continuous step intensity at model time."""
        if not self.enabled or not self.points:
            return 0.0
        intensity = self.points[0].intensity_mm_per_hour
        for point in self.points[1:]:
            if time_seconds < point.time_minutes * 60:
                break
            intensity = point.intensity_mm_per_hour
        return intensity

    def intervals(self, duration_seconds: float) -> tuple[dict, ...]:
        if not self.enabled:
            return ()
        intervals = []
        for index, point in enumerate(self.points):
            start_seconds = point.time_minutes * 60
            end_seconds = (
                self.points[index + 1].time_minutes * 60
                if index + 1 < len(self.points)
                else duration_seconds
            )
            duration = max(0.0, end_seconds - start_seconds)
            depth_mm = point.intensity_mm_per_hour * duration / 3600.0
            intervals.append({
                "startSeconds": start_seconds,
                "endSeconds": end_seconds,
                "intensityMmPerHour": point.intensity_mm_per_hour,
                "depthMm": depth_mm,
            })
        return tuple(intervals)

    def depth_between_mm(self, start_seconds: float, end_seconds: float) -> float:
        if end_seconds <= start_seconds:
            return 0.0
        depth = 0.0
        for item in self.intervals(end_seconds):
            overlap_start = max(start_seconds, item["startSeconds"])
            overlap_end = min(end_seconds, item["endSeconds"])
            if overlap_end > overlap_start:
                depth += (
                    item["intensityMmPerHour"]
                    * (overlap_end - overlap_start)
                    / 3600.0
                )
        return depth

    def cumulative_depth_mm(self, duration_seconds: float) -> float:
        return sum(
            item["depthMm"] for item in self.intervals(duration_seconds)
        )

    @property
    def peak_intensity_mm_per_hour(self) -> float:
        return max(
            (point.intensity_mm_per_hour for point in self.points),
            default=0.0,
        )


@dataclass(frozen=True)
class ScenarioSpec:
    name: str
    duration_seconds: float
    yieldstep_seconds: float
    friction_scenario: str
    inlets: tuple[InletSpec, ...]
    rainfall: RainfallSpec

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

        rainfall = RainfallSpec.from_dict(data.get("rainfall"), duration)
        raw_inlets = data.get("inlets")
        if not isinstance(raw_inlets, list):
            raise ScenarioValidationError("inlets must be an array")
        inlets = tuple(
            inlet
            for item in raw_inlets
            if (inlet := InletSpec.from_dict(item, mapping)) is not None
        )
        if not inlets and not (
            rainfall.enabled
            and rainfall.peak_intensity_mm_per_hour > 0
        ):
            raise ScenarioValidationError(
                "scenario needs at least one effective water source")
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
            rainfall=rainfall,
        )
