"""HTTP request contracts for scenarios and jobs."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class InletRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(min_length=1, max_length=100)
    name: str | None = Field(default=None, max_length=200)
    enabled: bool = True
    cell_ids: list[str] = Field(alias="cellIds")
    discharge_m3s: float = Field(alias="dischargeM3s")
    velocity_mode: Literal["zero", "components", "bearing"] = Field(
        default="zero", alias="velocityMode"
    )
    velocity_u_mps: float | None = Field(default=None, alias="velocityUMps")
    velocity_v_mps: float | None = Field(default=None, alias="velocityVMps")
    speed_mps: float | None = Field(default=None, alias="speedMps")
    bearing_degrees: float | None = Field(default=None,
                                          alias="bearingDegrees")
    initial_water_level_m: float | None = Field(
        default=None, alias="initialWaterLevelM"
    )
    display_color: str = Field(default="#00D8FF", alias="displayColor")


class ScenarioRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str = Field(min_length=1, max_length=200)
    dem_product_id: str = Field(
        min_length=1, max_length=100, alias="demProductId"
    )
    simulation_area_id: str = Field(
        min_length=64, max_length=64, alias="simulationAreaId"
    )
    duration_seconds: float = Field(alias="durationSeconds")
    yieldstep_seconds: float = Field(alias="yieldstepSeconds")
    friction_scenario: Literal["low", "middle", "high"] = Field(
        alias="frictionScenario"
    )
    inlets: list[InletRequest]

    def snapshot(self) -> dict:
        return self.model_dump(by_alias=True, exclude_none=True)


class JobCreateRequest(BaseModel):
    confirm_warnings: bool = Field(default=False, alias="confirmWarnings")


class GridSelectionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    cell_ids: list[str] = Field(alias="cellIds", min_length=1)
    friction_scenario: Literal["low", "middle", "high"] = Field(
        default="middle", alias="frictionScenario"
    )


class SimulationAreaResolveRequest(BaseModel):
    geometry: dict
