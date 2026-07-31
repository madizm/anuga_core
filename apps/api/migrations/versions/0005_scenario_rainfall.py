"""Add optional uniform rainfall profiles to scenarios.

Revision ID: 0005
Revises: 0004
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


_DISABLED_RAINFALL = '{"enabled": false, "points": []}'


def upgrade() -> None:
    with op.batch_alter_table("scenarios") as batch:
        batch.add_column(sa.Column(
            "rainfall",
            sa.JSON(),
            nullable=False,
            server_default=sa.text(f"'{_DISABLED_RAINFALL}'"),
        ))


def downgrade() -> None:
    with op.batch_alter_table("scenarios") as batch:
        batch.drop_column("rainfall")
