"""Persistent scenario, job, frame, and artifact records."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def uuid_string() -> str:
    return str(uuid.uuid4())


class DemProduct(Base):
    """Immutable terrain/model-input bundle selectable by simulations."""

    __tablename__ = "dem_products"

    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(20), default="active")
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    dataset_version: Mapped[str] = mapped_column(String(200), unique=True)
    dem_uri: Mapped[str] = mapped_column(Text)
    model_inputs_uri: Mapped[str] = mapped_column(Text)
    dem_sha256: Mapped[str] = mapped_column(String(64))
    model_inputs_sha256: Mapped[str] = mapped_column(String(64))
    crs: Mapped[str] = mapped_column(String(100))
    vertical_datum: Mapped[str] = mapped_column(String(100))
    elevation_unit: Mapped[str] = mapped_column(String(20), default="m")
    cell_size_m: Mapped[float] = mapped_column(Float)
    source_resolution_m: Mapped[float] = mapped_column(Float)
    resampling_method: Mapped[str] = mapped_column(String(40))
    max_cells: Mapped[int] = mapped_column(Integer)
    resource_queue: Mapped[str] = mapped_column(
        String(100), default="standard")
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )
    __table_args__ = (
        CheckConstraint(
            "status in ('active', 'deprecated', 'unavailable')",
            name="ck_dem_product_status",
        ),
    )


class Scenario(Base):
    __tablename__ = "scenarios"

    id: Mapped[str] = mapped_column(String(36), primary_key=True,
                                    default=uuid_string)
    name: Mapped[str] = mapped_column(String(200))
    dem_product_id: Mapped[str] = mapped_column(
        ForeignKey("dem_products.id"), index=True
    )
    simulation_area_hash: Mapped[str] = mapped_column(String(64))
    duration_seconds: Mapped[float] = mapped_column(Float)
    yieldstep_seconds: Mapped[float] = mapped_column(Float)
    friction_scenario: Mapped[str] = mapped_column(String(16))
    rainfall: Mapped[dict] = mapped_column(
        JSON, default=lambda: {"enabled": False, "points": []}
    )
    hydraulic_features: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 default=utcnow,
                                                 onupdate=utcnow)
    inlets: Mapped[list[ScenarioInlet]] = relationship(
        cascade="all, delete-orphan",
        order_by="ScenarioInlet.sort_order",
        back_populates="scenario",
    )


class ScenarioInlet(Base):
    __tablename__ = "scenario_inlets"

    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    scenario_id: Mapped[str] = mapped_column(
        ForeignKey("scenarios.id", ondelete="CASCADE"), primary_key=True
    )
    name: Mapped[str] = mapped_column(String(200))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    discharge_m3s: Mapped[float] = mapped_column(Float)
    velocity_mode: Mapped[str] = mapped_column(String(20))
    velocity_u_mps: Mapped[float | None] = mapped_column(Float, nullable=True)
    velocity_v_mps: Mapped[float | None] = mapped_column(Float, nullable=True)
    speed_mps: Mapped[float | None] = mapped_column(Float, nullable=True)
    bearing_degrees: Mapped[float | None] = mapped_column(Float, nullable=True)
    initial_water_level_m: Mapped[float | None] = mapped_column(Float,
                                                                nullable=True)
    display_color: Mapped[str] = mapped_column(String(20), default="#00D8FF")
    sort_order: Mapped[int] = mapped_column(Integer)
    scenario: Mapped[Scenario] = relationship(back_populates="inlets")
    cells: Mapped[list[ScenarioInletCell]] = relationship(
        cascade="all, delete-orphan", order_by="ScenarioInletCell.cell_id"
    )


class ScenarioInletCell(Base):
    __tablename__ = "scenario_inlet_cells"

    scenario_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    inlet_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    cell_id: Mapped[str] = mapped_column(String(20), primary_key=True)
    __table_args__ = (
        ForeignKeyConstraint(
            ["scenario_id", "inlet_id"],
            ["scenario_inlets.scenario_id", "scenario_inlets.id"],
            ondelete="CASCADE",
        ),
    )


class SimulationJob(Base):
    __tablename__ = "simulation_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True,
                                    default=uuid_string)
    scenario_id: Mapped[str] = mapped_column(String(36),
                                             ForeignKey("scenarios.id"))
    dem_product_id: Mapped[str] = mapped_column(
        ForeignKey("dem_products.id"), index=True
    )
    simulation_area_hash: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(20), default="QUEUED")
    scenario_snapshot: Mapped[dict] = mapped_column(JSON)
    current_frame: Mapped[int] = mapped_column(Integer, default=-1)
    frame_count: Mapped[int] = mapped_column(Integer)
    simulation_time_seconds: Mapped[float] = mapped_column(Float, default=0)
    maximum_depth_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    applied_volume_m3: Mapped[float | None] = mapped_column(
        Float, nullable=True)
    final_water_volume_m3: Mapped[float | None] = mapped_column(Float,
                                                                nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class SimulationFrame(Base):
    __tablename__ = "simulation_frames"

    job_id: Mapped[str] = mapped_column(
        ForeignKey("simulation_jobs.id", ondelete="CASCADE"), primary_key=True
    )
    frame_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    time_seconds: Mapped[float] = mapped_column(Float)
    cog_uri: Mapped[str] = mapped_column(Text)
    maximum_depth_m: Mapped[float] = mapped_column(Float)
    maximum_speed_mps: Mapped[float] = mapped_column(Float)
    wet_area_m2: Mapped[float] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 default=utcnow)
    __table_args__ = (
        UniqueConstraint("job_id", "time_seconds", name="uq_frame_time"),
    )


class SimulationArtifact(Base):
    __tablename__ = "simulation_artifacts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True,
                                    default=uuid_string)
    job_id: Mapped[str] = mapped_column(
        ForeignKey("simulation_jobs.id", ondelete="CASCADE"), index=True
    )
    type: Mapped[str] = mapped_column(String(40))
    uri: Mapped[str] = mapped_column(Text)
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 default=utcnow)


class FullPreviewJob(Base):
    """Immutable execution record for one regional rainfall preview."""

    __tablename__ = "full_preview_jobs"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=uuid_string
    )
    dem_product_id: Mapped[str] = mapped_column(
        ForeignKey("dem_products.id"), index=True
    )
    domain_id: Mapped[str] = mapped_column(String(100))
    dataset_version: Mapped[str] = mapped_column(String(200))
    assumptions_profile_id: Mapped[str] = mapped_column(String(100))
    runoff_coefficient: Mapped[float] = mapped_column(Float)
    cache_identity_hash: Mapped[str] = mapped_column(String(64))
    compatibility_version: Mapped[str] = mapped_column(String(64), index=True)
    rainfall_depth_mm: Mapped[float] = mapped_column(Float)
    effective_rainfall_depth_mm: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(20), default="QUEUED")
    phase: Mapped[str | None] = mapped_column(String(40), nullable=True)
    execution_attempt: Mapped[int] = mapped_column(Integer, default=0)
    execution_token: Mapped[str | None] = mapped_column(
        String(36), nullable=True
    )
    execution_lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    cache_hit: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    result_cog_uri: Mapped[str | None] = mapped_column(Text, nullable=True)
    report_uri: Mapped[str | None] = mapped_column(Text, nullable=True)
    bounds: Mapped[list | None] = mapped_column(JSON, nullable=True)
    maximum_depth_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    wet_area_m2: Mapped[float | None] = mapped_column(Float, nullable=True)
    threshold_areas_m2: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    input_volume_m3: Mapped[float | None] = mapped_column(Float, nullable=True)
    retained_volume_m3: Mapped[float | None] = mapped_column(Float, nullable=True)
    outflow_volume_m3: Mapped[float | None] = mapped_column(Float, nullable=True)
    mass_balance_error_m3: Mapped[float | None] = mapped_column(
        Float, nullable=True
    )
    error_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    __table_args__ = (
        CheckConstraint(
            "status in ('QUEUED', 'PREPARING', 'SOLVING', 'PUBLISHING', "
            "'COMPLETED', 'FAILED')",
            name="ck_full_preview_status",
        ),
    )
