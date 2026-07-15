"""Create fixed model, scenario, job, frame, and artifact tables.

Revision ID: 0001
Revises:
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    op.create_table(
        "fixed_model_versions",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("crs", sa.String(32), nullable=False),
        sa.Column("mesh_sha256", sa.String(64), nullable=False, unique=True),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "scenarios",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("duration_seconds", sa.Float(), nullable=False),
        sa.Column("yieldstep_seconds", sa.Float(), nullable=False),
        sa.Column("friction_scenario", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "scenario_inlets",
        sa.Column("id", sa.String(100), primary_key=True),
        sa.Column(
            "scenario_id",
            sa.String(36),
            sa.ForeignKey("scenarios.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("discharge_m3s", sa.Float(), nullable=False),
        sa.Column("velocity_mode", sa.String(20), nullable=False),
        sa.Column("velocity_u_mps", sa.Float(), nullable=True),
        sa.Column("velocity_v_mps", sa.Float(), nullable=True),
        sa.Column("speed_mps", sa.Float(), nullable=True),
        sa.Column("bearing_degrees", sa.Float(), nullable=True),
        sa.Column("initial_water_level_m", sa.Float(), nullable=True),
        sa.Column("display_color", sa.String(20), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
    )
    op.create_table(
        "scenario_inlet_cells",
        sa.Column("scenario_id", sa.String(36), primary_key=True),
        sa.Column("inlet_id", sa.String(100), primary_key=True),
        sa.Column("cell_id", sa.String(20), primary_key=True),
        sa.ForeignKeyConstraint(
            ["scenario_id", "inlet_id"],
            ["scenario_inlets.scenario_id", "scenario_inlets.id"],
            ondelete="CASCADE",
        ),
    )
    op.create_table(
        "simulation_jobs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "scenario_id",
            sa.String(36),
            sa.ForeignKey("scenarios.id"),
            nullable=False,
        ),
        sa.Column(
            "fixed_model_version_id",
            sa.String(64),
            sa.ForeignKey("fixed_model_versions.id"),
            nullable=False,
        ),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("scenario_snapshot", sa.JSON(), nullable=False),
        sa.Column("current_frame", sa.Integer(), nullable=False),
        sa.Column("frame_count", sa.Integer(), nullable=False),
        sa.Column("simulation_time_seconds", sa.Float(), nullable=False),
        sa.Column("maximum_depth_m", sa.Float(), nullable=True),
        sa.Column("applied_volume_m3", sa.Float(), nullable=True),
        sa.Column("final_water_volume_m3", sa.Float(), nullable=True),
        sa.Column("error_code", sa.String(100), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "simulation_frames",
        sa.Column(
            "job_id",
            sa.String(36),
            sa.ForeignKey("simulation_jobs.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("frame_index", sa.Integer(), primary_key=True),
        sa.Column("time_seconds", sa.Float(), nullable=False),
        sa.Column("cog_uri", sa.Text(), nullable=False),
        sa.Column("maximum_depth_m", sa.Float(), nullable=False),
        sa.Column("maximum_speed_mps", sa.Float(), nullable=False),
        sa.Column("wet_area_m2", sa.Float(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("job_id", "time_seconds", name="uq_frame_time"),
    )
    op.create_table(
        "simulation_artifacts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "job_id",
            sa.String(36),
            sa.ForeignKey("simulation_jobs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("type", sa.String(40), nullable=False),
        sa.Column("uri", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_simulation_artifacts_job_id",
        "simulation_artifacts",
        ["job_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_simulation_artifacts_job_id",
        table_name="simulation_artifacts",
    )
    op.drop_table("simulation_artifacts")
    op.drop_table("simulation_frames")
    op.drop_table("simulation_jobs")
    op.drop_table("scenario_inlet_cells")
    op.drop_table("scenario_inlets")
    op.drop_table("scenarios")
    op.drop_table("fixed_model_versions")
