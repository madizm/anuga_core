"""Replace fixed-model scenario/job identity with local simulation areas.

Revision ID: 0002
Revises: 0001
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The product explicitly does not preserve fixed-model scenarios or jobs.
    op.execute(sa.text("DELETE FROM simulation_artifacts"))
    op.execute(sa.text("DELETE FROM simulation_frames"))
    op.execute(sa.text("DELETE FROM simulation_jobs"))
    op.execute(sa.text("DELETE FROM scenario_inlet_cells"))
    op.execute(sa.text("DELETE FROM scenario_inlets"))
    op.execute(sa.text("DELETE FROM scenarios"))

    with op.batch_alter_table("scenarios") as batch:
        batch.add_column(sa.Column(
            "simulation_area_hash", sa.String(64), nullable=True
        ))
    with op.batch_alter_table("simulation_jobs") as batch:
        batch.add_column(sa.Column(
            "simulation_area_hash", sa.String(64), nullable=True
        ))
        batch.drop_column("fixed_model_version_id")
    with op.batch_alter_table("scenarios") as batch:
        batch.alter_column("simulation_area_hash", nullable=False)
    with op.batch_alter_table("simulation_jobs") as batch:
        batch.alter_column("simulation_area_hash", nullable=False)


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM simulation_artifacts"))
    op.execute(sa.text("DELETE FROM simulation_frames"))
    op.execute(sa.text("DELETE FROM simulation_jobs"))
    op.execute(sa.text("DELETE FROM scenario_inlet_cells"))
    op.execute(sa.text("DELETE FROM scenario_inlets"))
    op.execute(sa.text("DELETE FROM scenarios"))

    with op.batch_alter_table("simulation_jobs") as batch:
        batch.add_column(sa.Column(
            "fixed_model_version_id", sa.String(64), nullable=True
        ))
        batch.drop_column("simulation_area_hash")
    with op.batch_alter_table("scenarios") as batch:
        batch.drop_column("simulation_area_hash")
    with op.batch_alter_table("simulation_jobs") as batch:
        batch.alter_column("fixed_model_version_id", nullable=False)
        batch.create_foreign_key(
            "fk_simulation_jobs_fixed_model_version_id",
            "fixed_model_versions",
            ["fixed_model_version_id"],
            ["id"],
        )
