"""Remove the obsolete fixed-model catalog.

Revision ID: 0003
Revises: 0002
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("fixed_model_versions")


def downgrade() -> None:
    op.create_table(
        "fixed_model_versions",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("crs", sa.String(32), nullable=False),
        sa.Column("mesh_sha256", sa.String(64), nullable=False, unique=True),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
