"""Store workbench-drawn hydraulic features.

Revision ID: 0006
Revises: 0005
"""

from alembic import op
import sqlalchemy as sa

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("scenarios") as batch:
        batch.add_column(sa.Column(
            "hydraulic_features",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'"),
        ))


def downgrade() -> None:
    with op.batch_alter_table("scenarios") as batch:
        batch.drop_column("hydraulic_features")
