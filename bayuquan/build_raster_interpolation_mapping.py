#!/usr/bin/env python3
"""Precompute fixed pixel-centre interpolation for Bayuquan frame output."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

import anuga

from bayuquan.raster.interpolation import (
    RasterGrid,
    build_interpolation_mapping,
)
from bayuquan.simulation.grid_mapping import GridTriangleMapping


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--project-root", type=Path, default=Path("/workspace")
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    directory = args.project_root / "OUTPUT/model/grid_mapping"
    mesh_path = directory / "bayuquan_fixed_mesh.msh"
    cell_mapping = GridTriangleMapping.load(
        directory / "grid_triangle_mapping.npz"
    )
    domain = anuga.Domain(str(mesh_path), use_cache=False, verbose=False)
    cell_mapping.validate_mesh(mesh_path, len(domain.areas))
    grid = RasterGrid(
        rows=cell_mapping.nrows,
        columns=cell_mapping.ncols,
        cellsize=cell_mapping.cellsize,
        xllcorner=cell_mapping.xllcorner,
        yllcorner=cell_mapping.yllcorner,
    )
    vertices = domain.get_vertex_coordinates(absolute=True).reshape(-1, 3, 2)
    mapping = build_interpolation_mapping(
        vertices, grid, cell_mapping.mesh_sha256
    )
    output = directory / "raster_interpolation_mapping.npz"
    mapping.save(output)

    valid = mapping.valid_mask
    report = {
        "path": str(output.relative_to(args.project_root)),
        "meshSha256": mapping.mesh_sha256,
        "rows": grid.rows,
        "columns": grid.columns,
        "cellsizeM": grid.cellsize,
        "xllcorner": grid.xllcorner,
        "yllcorner": grid.yllcorner,
        "upperLeftY": grid.upper_left_y,
        "crs": grid.crs,
        "validPixelCount": int(valid.sum()),
        "maskedPixelCount": int((~valid).sum()),
        "minimumWeight": float(
            np.nanmin(mapping.barycentric_weights)
        ),
        "maximumWeight": float(
            np.nanmax(mapping.barycentric_weights)
        ),
    }
    report_path = directory / "raster_interpolation_report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
