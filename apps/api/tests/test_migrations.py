from __future__ import annotations

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect


def test_initial_migration_round_trip(tmp_path, monkeypatch):
    database_url = f"sqlite:///{tmp_path / 'migration.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", database_url)
    config = Config("alembic.ini")

    command.upgrade(config, "head")

    inspector = inspect(create_engine(database_url))
    assert set(inspector.get_table_names()) == {
        "alembic_version",
        "fixed_model_versions",
        "scenario_inlet_cells",
        "scenario_inlets",
        "scenarios",
        "simulation_artifacts",
        "simulation_frames",
        "simulation_jobs",
    }
    assert {item["name"] for item in inspector.get_indexes(
        "simulation_artifacts"
    )} == {"ix_simulation_artifacts_job_id"}

    command.downgrade(config, "base")

    assert inspect(create_engine(database_url)).get_table_names() == [
        "alembic_version"
    ]
