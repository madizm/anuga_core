"""Read-only catalog for the deployed Bayuquan fixed model."""

from __future__ import annotations

import csv
import json
from functools import cached_property
from pathlib import Path

from bayuquan.simulation.fixed_model import FixedModelPaths
from bayuquan.simulation.grid_mapping import GridTriangleMapping


class FixedModelCatalog:
    def __init__(self, project_root: Path | str):
        self.project_root = Path(project_root)
        self.paths = FixedModelPaths.under(self.project_root)
        self.directory = self.paths.mapping.parent

    @cached_property
    def mapping(self) -> GridTriangleMapping:
        result = GridTriangleMapping.load(self.paths.mapping)
        report = self.report
        result.validate_mesh(self.paths.mesh,
                             report["mesh"]["triangle_count"])
        return result

    @cached_property
    def report(self) -> dict:
        return json.loads((self.directory / "mapping_report.json").read_text())

    @cached_property
    def grid_geojson(self) -> dict:
        return json.loads(
            (self.directory / "dem_grid_cells.geojson").read_text()
        )

    @cached_property
    def cells(self) -> dict[str, dict]:
        path = self.directory / "dem_grid_cells.csv"
        with path.open(newline="") as source:
            return {row["cell_id"]: row for row in csv.DictReader(source)}

    @property
    def version_id(self) -> str:
        return self.mapping.mesh_sha256[:8]

    def metadata(self) -> dict:
        grid = self.report["dem_grid"]
        return {
            "version": self.version_id,
            "crs": "EPSG:32651",
            "gridRows": grid["rows"],
            "gridColumns": grid["columns"],
            "cellSizeM": grid["cellsize_m"],
            "selectableCellCount": grid["selectable_cells"],
            "gridUrl": "/api/model/grid",
            "boundaryCondition": "transmissive",
            "meshSha256": self.mapping.mesh_sha256,
        }

    def cell(self, cell_id: str) -> dict | None:
        row = self.cells.get(cell_id)
        if row is None:
            return None
        numeric_float = {
            "elevation_m",
            "building_fraction",
            "manning_low",
            "manning_middle",
            "manning_high",
            "effective_triangle_area_m2",
        }
        numeric_int = {"row", "column", "triangle_count"}
        return {
            key: (float(value) if key in numeric_float else
                  int(value) if key in numeric_int else
                  value.lower() == "true" if key == "selectable" else value)
            for key, value in row.items()
        }
