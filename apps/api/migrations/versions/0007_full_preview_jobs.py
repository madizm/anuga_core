"""Add independent regional full-preview jobs.

Revision ID: 0007
Revises: 0006
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "full_preview_jobs",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "dem_product_id",
            sa.String(length=100),
            sa.ForeignKey("dem_products.id"),
            nullable=False,
        ),
        sa.Column("domain_id", sa.String(length=100), nullable=False),
        sa.Column(
            "assumptions_profile_id", sa.String(length=100), nullable=False
        ),
        sa.Column("rainfall_depth_mm", sa.Float(), nullable=False),
        sa.Column("effective_rainfall_depth_mm", sa.Float(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("phase", sa.String(length=40), nullable=True),
        sa.Column("cache_hit", sa.Boolean(), nullable=True),
        sa.Column("result_cog_uri", sa.Text(), nullable=True),
        sa.Column("report_uri", sa.Text(), nullable=True),
        sa.Column("bounds", sa.JSON(), nullable=True),
        sa.Column("maximum_depth_m", sa.Float(), nullable=True),
        sa.Column("wet_area_m2", sa.Float(), nullable=True),
        sa.Column("threshold_areas_m2", sa.JSON(), nullable=True),
        sa.Column("input_volume_m3", sa.Float(), nullable=True),
        sa.Column("retained_volume_m3", sa.Float(), nullable=True),
        sa.Column("outflow_volume_m3", sa.Float(), nullable=True),
        sa.Column("mass_balance_error_m3", sa.Float(), nullable=True),
        sa.Column("error_code", sa.String(length=100), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status in ('QUEUED', 'PREPARING', 'SOLVING', 'PUBLISHING', "
            "'COMPLETED', 'FAILED')",
            name="ck_full_preview_status",
        ),
    )
    op.create_index(
        "ix_full_preview_jobs_dem_product_id",
        "full_preview_jobs",
        ["dem_product_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_full_preview_jobs_dem_product_id",
        table_name="full_preview_jobs",
    )
    op.drop_table("full_preview_jobs")
