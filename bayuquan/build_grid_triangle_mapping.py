#!/usr/bin/env python3
"""Build the fixed Bayuquan mesh and its 30 m DEM-cell mapping.

A triangle belongs to the single DEM cell containing its centroid. The output
mapping is the authoritative conversion from web-selected grid cells to ANUGA
triangle indices.
"""

from __future__ import annotations

import csv
import hashlib
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
from pyproj import Transformer

import anuga
from anuga.pmesh.mesh_interface import create_pmesh_from_regions

from bayuquan.simulation.fixed_model import AsciiGrid
from bayuquan.simulation.geometry import counter_clockwise
from bayuquan.simulation.geometry import load_projected_areas


PROJECT = Path("/workspace")
OUTPUT = PROJECT / "OUTPUT/model/grid_mapping"
CRS = "EPSG:32651"
MAX_TRIANGLE_AREA_M2 = 450.0


def assert_same_grid(
    reference: AsciiGrid, other: AsciiGrid, name: str
) -> None:
    expected = (
        reference.ncols,
        reference.nrows,
        reference.xll,
        reference.yll,
        reference.cellsize,
    )
    actual = (other.ncols, other.nrows, other.xll, other.yll, other.cellsize)
    if actual != expected:
        raise ValueError(f"{name} is not aligned with the elevation grid")


def value_at(grid: AsciiGrid, row: int, column: int) -> float:
    value = float(grid.values[row, column])
    if grid.nodata is not None and value == grid.nodata:
        raise ValueError(f"NoData at row={row}, column={column}")
    return value


def cell_id(row: int, column: int) -> str:
    return f"r{row:04d}-c{column:04d}"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)

    elevation = AsciiGrid(PROJECT / "OUTPUT/model/elevation_30m.asc")
    rasters = {
        "building_fraction": AsciiGrid(
            PROJECT / "OUTPUT/model/building_fraction_30m.asc"
        ),
        "manning_low": AsciiGrid(PROJECT / "OUTPUT/model/manning_low_30m.asc"),
        "manning_middle": AsciiGrid(
            PROJECT / "OUTPUT/model/manning_middle_30m.asc"
        ),
        "manning_high": AsciiGrid(
            PROJECT / "OUTPUT/model/manning_high_30m.asc"
        ),
    }
    for name, raster in rasters.items():
        assert_same_grid(elevation, raster, name)

    areas = load_projected_areas(PROJECT / "bayuquan/model_areas.geojson")
    boundary = counter_clockwise(areas["simulation_boundary"])
    mesh_path = OUTPUT / "bayuquan_fixed_mesh.msh"
    print(f"Generating fixed mesh: {mesh_path}", flush=True)
    create_pmesh_from_regions(
        boundary,
        boundary_tags={"open": list(range(len(boundary)))},
        maximum_triangle_area=MAX_TRIANGLE_AREA_M2,
        filename=str(mesh_path),
        poly_geo_reference=anuga.Geo_reference(epsg=32651),
        minimum_triangle_angle=28.0,
        use_cache=False,
        verbose=False,
    )

    domain = anuga.Domain(str(mesh_path), use_cache=False, verbose=False)
    centroids = domain.get_centroid_coordinates(absolute=True)
    triangle_areas = np.asarray(domain.areas)

    columns = np.floor(
        (centroids[:, 0] - elevation.xll) / elevation.cellsize).astype(int)
    rows_from_bottom = np.floor(
        (centroids[:, 1] - elevation.yll) / elevation.cellsize
    ).astype(int)
    rows = elevation.nrows - 1 - rows_from_bottom
    inside = (
        (rows >= 0)
        & (rows < elevation.nrows)
        & (columns >= 0)
        & (columns < elevation.ncols)
    )
    if not np.all(inside):
        invalid = np.flatnonzero(~inside)
        raise ValueError(
            f"{len(invalid)} mesh centroids fall outside the DEM grid")

    linear_cell_indices = rows * elevation.ncols + columns
    triangles_by_cell: dict[int, list[int]] = defaultdict(list)
    for triangle_id, linear_index in enumerate(linear_cell_indices):
        triangles_by_cell[int(linear_index)].append(triangle_id)

    mapping_csv = OUTPUT / "triangle_grid_mapping.csv"
    with mapping_csv.open("w", newline="") as target:
        writer = csv.writer(target)
        writer.writerow([
            "triangle_id",
            "cell_id",
            "row",
            "column",
            "centroid_easting",
            "centroid_northing",
            "triangle_area_m2",
        ])
        for triangle_id, (row, column, centroid, area) in enumerate(
            zip(rows, columns, centroids, triangle_areas)
        ):
            writer.writerow([
                triangle_id,
                cell_id(int(row), int(column)),
                int(row),
                int(column),
                f"{centroid[0]:.6f}",
                f"{centroid[1]:.6f}",
                f"{area:.9f}",
            ])

    # Compact runtime representation. A selected linear cell index can be
    # matched directly against triangle_cell_index without geometry work.
    npz_path = OUTPUT / "grid_triangle_mapping.npz"
    np.savez_compressed(
        npz_path,
        triangle_cell_index=linear_cell_indices.astype(np.int32),
        triangle_row=rows.astype(np.int16),
        triangle_column=columns.astype(np.int16),
        triangle_area_m2=triangle_areas,
        nrows=np.int32(elevation.nrows),
        ncols=np.int32(elevation.ncols),
        xllcorner=np.float64(elevation.xll),
        yllcorner=np.float64(elevation.yll),
        cellsize=np.float64(elevation.cellsize),
        mesh_sha256=np.array(sha256(mesh_path)),
    )

    to_wgs84 = Transformer.from_crs(CRS, "OGC:CRS84", always_xy=True)
    features = []
    cells_csv = OUTPUT / "dem_grid_cells.csv"
    triangle_counts = []
    effective_areas = []
    with cells_csv.open("w", newline="") as target:
        writer = csv.writer(target)
        writer.writerow([
            "cell_id",
            "row",
            "column",
            "elevation_m",
            "building_fraction",
            "manning_low",
            "manning_middle",
            "manning_high",
            "triangle_count",
            "effective_triangle_area_m2",
            "selectable",
        ])
        for linear_index in sorted(triangles_by_cell):
            row, column = divmod(linear_index, elevation.ncols)
            triangle_ids = triangles_by_cell[linear_index]
            effective_area = float(triangle_areas[triangle_ids].sum())
            triangle_counts.append(len(triangle_ids))
            effective_areas.append(effective_area)
            properties = {
                "cell_id": cell_id(row, column),
                "row": row,
                "column": column,
                "elevation_m": value_at(elevation, row, column),
                "building_fraction": value_at(
                    rasters["building_fraction"], row, column
                ),
                "manning_low": value_at(rasters["manning_low"], row, column),
                "manning_middle": value_at(
                    rasters["manning_middle"], row, column
                ),
                "manning_high": value_at(rasters["manning_high"], row, column),
                "triangle_count": len(triangle_ids),
                "effective_triangle_area_m2": effective_area,
                "selectable": True,
            }
            writer.writerow(properties.values())

            xmin = elevation.xll + column * elevation.cellsize
            xmax = xmin + elevation.cellsize
            ymax = elevation.yll + (elevation.nrows - row) * elevation.cellsize
            ymin = ymax - elevation.cellsize
            ring_utm = [
                (xmin, ymin),
                (xmax, ymin),
                (xmax, ymax),
                (xmin, ymax),
                (xmin, ymin),
            ]
            ring_wgs84 = [list(to_wgs84.transform(x, y)) for x, y in ring_utm]
            features.append({
                "type": "Feature",
                "properties": properties,
                "geometry": {"type": "Polygon", "coordinates": [ring_wgs84]},
            })

    geojson_path = OUTPUT / "dem_grid_cells.geojson"
    geojson_path.write_text(json.dumps(
        {"type": "FeatureCollection", "features": features},
        ensure_ascii=False,
        separators=(",", ":"),
    ) + "\n")

    report = {
        "crs": CRS,
        "assignment_rule": "triangle centroid belongs to one DEM cell",
        "mesh": {
            "path": str(mesh_path.relative_to(PROJECT)),
            "sha256": sha256(mesh_path),
            "maximum_triangle_area_m2": MAX_TRIANGLE_AREA_M2,
            "triangle_count": len(triangle_areas),
            "total_area_m2": float(triangle_areas.sum()),
        },
        "dem_grid": {
            "rows": elevation.nrows,
            "columns": elevation.ncols,
            "total_cells": elevation.nrows * elevation.ncols,
            "selectable_cells": len(triangles_by_cell),
            "cellsize_m": elevation.cellsize,
            "cell_area_m2": elevation.cellsize ** 2,
            "xllcorner": elevation.xll,
            "yllcorner": elevation.yll,
        },
        "mapping": {
            "mapped_triangles": len(linear_cell_indices),
            "unmapped_triangles": int((~inside).sum()),
            "minimum_triangles_per_selectable_cell": min(triangle_counts),
            "maximum_triangles_per_selectable_cell": max(triangle_counts),
            "mean_triangles_per_selectable_cell": float(
                np.mean(triangle_counts)
            ),
            "minimum_effective_cell_area_m2": min(effective_areas),
            "maximum_effective_cell_area_m2": max(effective_areas),
            "mean_effective_cell_area_m2": float(np.mean(effective_areas)),
        },
        "artifacts": {
            "triangle_csv": str(mapping_csv.relative_to(PROJECT)),
            "runtime_npz": str(npz_path.relative_to(PROJECT)),
            "grid_csv": str(cells_csv.relative_to(PROJECT)),
            "web_geojson": str(geojson_path.relative_to(PROJECT)),
            "grid_geopackage": "OUTPUT/model/grid_mapping/dem_grid_cells.gpkg",
        },
    }
    report_path = OUTPUT / "mapping_report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
