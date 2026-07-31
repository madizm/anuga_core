"""Add immutable selectable DEM products and reset demo data.

Revision ID: 0004
Revises: 0003
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The application is still a demo. Existing cell selections and snapshots
    # cannot be attributed to an immutable DEM product, so reset them instead
    # of inventing provenance.
    op.execute("DELETE FROM simulation_artifacts")
    op.execute("DELETE FROM simulation_frames")
    op.execute("DELETE FROM simulation_jobs")
    op.execute("DELETE FROM scenario_inlet_cells")
    op.execute("DELETE FROM scenario_inlets")
    op.execute("DELETE FROM scenarios")

    op.create_table(
        "dem_products",
        sa.Column("id", sa.String(100), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.Column("dataset_version", sa.String(200), nullable=False,
                  unique=True),
        sa.Column("dem_uri", sa.Text(), nullable=False),
        sa.Column("model_inputs_uri", sa.Text(), nullable=False),
        sa.Column("dem_sha256", sa.String(64), nullable=False),
        sa.Column("model_inputs_sha256", sa.String(64), nullable=False),
        sa.Column("crs", sa.String(100), nullable=False),
        sa.Column("vertical_datum", sa.String(100), nullable=False),
        sa.Column("elevation_unit", sa.String(20), nullable=False),
        sa.Column("cell_size_m", sa.Float(), nullable=False),
        sa.Column("source_resolution_m", sa.Float(), nullable=False),
        sa.Column("resampling_method", sa.String(40), nullable=False),
        sa.Column("max_cells", sa.Integer(), nullable=False),
        sa.Column("resource_queue", sa.String(100), nullable=False),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status in ('active', 'deprecated', 'unavailable')",
            name="ck_dem_product_status",
        ),
    )
    with op.batch_alter_table("scenarios") as batch:
        batch.add_column(
            sa.Column("dem_product_id", sa.String(100), nullable=False)
        )
        batch.create_index("ix_scenarios_dem_product_id", ["dem_product_id"])
        batch.create_foreign_key(
            "fk_scenarios_dem_product", "dem_products",
            ["dem_product_id"], ["id"],
        )
    with op.batch_alter_table("simulation_jobs") as batch:
        batch.add_column(
            sa.Column("dem_product_id", sa.String(100), nullable=False)
        )
        batch.create_index(
            "ix_simulation_jobs_dem_product_id", ["dem_product_id"]
        )
        batch.create_foreign_key(
            "fk_jobs_dem_product", "dem_products",
            ["dem_product_id"], ["id"],
        )


def downgrade() -> None:
    with op.batch_alter_table("simulation_jobs") as batch:
        batch.drop_constraint("fk_jobs_dem_product", type_="foreignkey")
        batch.drop_index("ix_simulation_jobs_dem_product_id")
        batch.drop_column("dem_product_id")
    with op.batch_alter_table("scenarios") as batch:
        batch.drop_constraint("fk_scenarios_dem_product", type_="foreignkey")
        batch.drop_index("ix_scenarios_dem_product_id")
        batch.drop_column("dem_product_id")
    op.drop_table("dem_products")
