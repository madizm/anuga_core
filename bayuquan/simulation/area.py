"""Resolve user geometry to a deterministic product-aligned domain."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.features import geometry_mask, geometry_window
from rasterio.windows import Window, transform as window_transform
from shapely.geometry import Polygon, box, mapping, shape
from shapely.ops import transform as transform_geometry


class SimulationAreaError(ValueError):
    """Raised when a requested simulation area cannot be resolved."""


@dataclass(frozen=True)
class SimulationArea:
    """Canonical, immutable set of valid DEM cells selected for one domain."""

    area_hash: str
    dataset_version: str
    crs: str
    cell_ids: tuple[str, ...]
    cell_indices: tuple[int, ...]
    cell_rows: tuple[int, ...]
    cell_columns: tuple[int, ...]
    nrows: int
    ncols: int
    transform: tuple[float, float, float, float, float, float]
    window: tuple[int, int, int, int]
    cell_size_m: float
    elevation_m: dict[str, float]

    @property
    def cell_count(self) -> int:
        return len(self.cell_ids)

    @property
    def area_m2(self) -> float:
        return self.cell_count * self.cell_size_m ** 2


@dataclass(frozen=True)
class LocalMesh:
    """ANUGA-ready structured mesh generated from a SimulationArea."""

    coordinates: np.ndarray
    triangles: np.ndarray
    boundary: dict[tuple[int, int], str]
    triangle_cell_index: np.ndarray
    origin: tuple[float, float]
    crs: str


class SimulationAreaResolver:
    """Project, snap, validate, and identify one user-selected area."""

    def __init__(
        self,
        dem_path: Path | str,
        *,
        dataset_version: str,
        max_cells: int = 25_000,
    ) -> None:
        if not dataset_version:
            raise ValueError("dataset_version must not be empty")
        if max_cells <= 0:
            raise ValueError("max_cells must be positive")
        self.dem_path = Path(dem_path)
        self.dataset_version = dataset_version
        self.max_cells = max_cells

    def resolve(
        self,
        geometry: Mapping,
        *,
        geometry_crs: str = "EPSG:4326",
    ) -> SimulationArea:
        """Resolve a GeoJSON polygon using DEM-cell centre inclusion."""
        requested = shape(geometry)
        if not isinstance(requested, Polygon):
            raise SimulationAreaError(
                "simulation area must be one Polygon"
            )
        if requested.is_empty or not requested.is_valid:
            raise SimulationAreaError("simulation area polygon is invalid")
        if requested.interiors:
            raise SimulationAreaError("simulation area holes are not supported")

        with rasterio.open(self.dem_path) as dem:
            if dem.crs is None:
                raise SimulationAreaError("DEM has no coordinate reference system")
            if not np.isclose(abs(dem.transform.a), abs(dem.transform.e)):
                raise SimulationAreaError("DEM cells must be square")
            if dem.transform.b != 0 or dem.transform.d != 0:
                raise SimulationAreaError("rotated DEM grids are not supported")

            projected = requested
            source_crs = rasterio.crs.CRS.from_user_input(geometry_crs)
            if source_crs != dem.crs:
                transformer = Transformer.from_crs(
                    source_crs, dem.crs, always_xy=True
                )
                projected = transform_geometry(transformer.transform, requested)
            if not box(*dem.bounds).covers(projected):
                raise SimulationAreaError(
                    "simulation area extends beyond the DEM coverage"
                )

            try:
                raw_window = geometry_window(
                    dem, [mapping(projected)], boundless=False
                )
            except (ValueError, rasterio.errors.WindowError) as error:
                raise SimulationAreaError(
                    "simulation area does not intersect the DEM"
                ) from error
            window = _integer_window(raw_window)
            local_transform = window_transform(window, dem.transform)
            requested_cells = geometry_mask(
                [mapping(projected)],
                out_shape=(int(window.height), int(window.width)),
                transform=local_transform,
                all_touched=False,
                invert=True,
            )
            elevations = dem.read(1, window=window, masked=True)
            invalid = np.ma.getmaskarray(elevations)
            if dem.nodata is not None:
                invalid |= np.asarray(elevations) == dem.nodata
            if np.any(requested_cells & invalid):
                raise SimulationAreaError(
                    "simulation area contains DEM NoData cells"
                )
            selected = requested_cells
            _require_no_holes(selected)

            local_rows, local_columns = np.nonzero(selected)
            if not len(local_rows):
                raise SimulationAreaError(
                    "simulation area contains no valid DEM cell centres"
                )
            rows = local_rows + int(window.row_off)
            columns = local_columns + int(window.col_off)
            indices = rows * dem.width + columns
            if len(indices) > self.max_cells:
                raise SimulationAreaError(
                    "simulation area contains "
                    f"{len(indices)} cells; maximum of {self.max_cells} allowed"
                )
            _require_connected(set(int(index) for index in indices), dem.width)

            ordered = np.argsort(indices)
            rows = rows[ordered]
            columns = columns[ordered]
            indices = indices[ordered]
            values = np.asarray(elevations)[local_rows, local_columns][ordered]
            cell_ids = tuple(
                f"r{int(row):04d}-c{int(column):04d}"
                for row, column in zip(rows, columns)
            )
            transform_values = (
                dem.transform.a,
                dem.transform.b,
                dem.transform.c,
                dem.transform.d,
                dem.transform.e,
                dem.transform.f,
            )
            crs = dem.crs.to_string()
            area_hash = _area_hash(
                dataset_version=self.dataset_version,
                crs=crs,
                shape=(dem.height, dem.width),
                transform=transform_values,
                cell_indices=indices,
            )
            return SimulationArea(
                area_hash=area_hash,
                dataset_version=self.dataset_version,
                crs=crs,
                cell_ids=cell_ids,
                cell_indices=tuple(int(value) for value in indices),
                cell_rows=tuple(int(value) for value in rows),
                cell_columns=tuple(int(value) for value in columns),
                nrows=dem.height,
                ncols=dem.width,
                transform=transform_values,
                window=(
                    int(rows.min()),
                    int(rows.max()) + 1,
                    int(columns.min()),
                    int(columns.max()) + 1,
                ),
                cell_size_m=float(abs(dem.transform.a)),
                elevation_m={
                    "minimum": float(values.min()),
                    "maximum": float(values.max()),
                    "mean": float(values.mean()),
                },
            )


def build_local_mesh(area: SimulationArea) -> LocalMesh:
    """Split every selected square into two deterministic triangles."""
    a, b, c, d, e, f = area.transform
    if b != 0 or d != 0 or a <= 0 or e >= 0:
        raise SimulationAreaError("area transform is not a north-up grid")

    minimum_column = min(area.cell_columns)
    maximum_row = max(area.cell_rows)
    origin_x = c + minimum_column * a
    origin_y = f + (maximum_row + 1) * e
    node_ids: dict[tuple[int, int], int] = {}
    coordinates: list[tuple[float, float]] = []

    def node(row_corner: int, column_corner: int) -> int:
        key = (row_corner, column_corner)
        existing = node_ids.get(key)
        if existing is not None:
            return existing
        absolute_x = c + column_corner * a
        absolute_y = f + row_corner * e
        node_id = len(coordinates)
        node_ids[key] = node_id
        coordinates.append((absolute_x - origin_x, absolute_y - origin_y))
        return node_id

    triangles: list[tuple[int, int, int]] = []
    triangle_cells: list[int] = []
    for row, column, cell_index in zip(
        area.cell_rows, area.cell_columns, area.cell_indices
    ):
        southwest = node(row + 1, column)
        southeast = node(row + 1, column + 1)
        northeast = node(row, column + 1)
        northwest = node(row, column)
        triangles.extend([
            (southwest, southeast, northeast),
            (southwest, northeast, northwest),
        ])
        triangle_cells.extend([cell_index, cell_index])

    edge_uses: Counter[tuple[int, int]] = Counter()
    triangle_edges: list[tuple[tuple[int, int], ...]] = []
    for triangle in triangles:
        edges = (
            tuple(sorted((triangle[1], triangle[2]))),
            tuple(sorted((triangle[2], triangle[0]))),
            tuple(sorted((triangle[0], triangle[1]))),
        )
        triangle_edges.append(edges)
        edge_uses.update(edges)
    boundary = {
        (triangle_id, edge_id): "open"
        for triangle_id, edges in enumerate(triangle_edges)
        for edge_id, edge in enumerate(edges)
        if edge_uses[edge] == 1
    }

    return LocalMesh(
        coordinates=np.asarray(coordinates, dtype=float),
        triangles=np.asarray(triangles, dtype=np.int32),
        boundary=boundary,
        triangle_cell_index=np.asarray(triangle_cells, dtype=np.int32),
        origin=(float(origin_x), float(origin_y)),
        crs=area.crs,
    )


def _integer_window(window: Window) -> Window:
    return Window(
        int(window.col_off),
        int(window.row_off),
        int(window.width),
        int(window.height),
    )


def _require_connected(cells: set[int], ncols: int) -> None:
    pending = [next(iter(cells))]
    visited = {pending[0]}
    while pending:
        index = pending.pop()
        row, column = divmod(index, ncols)
        neighbours = (
            index - ncols,
            index + ncols,
            index - 1 if column else -1,
            index + 1 if column + 1 < ncols else -1,
        )
        for neighbour in neighbours:
            if neighbour in cells and neighbour not in visited:
                visited.add(neighbour)
                pending.append(neighbour)
    if visited != cells:
        raise SimulationAreaError(
            "simulation area cells must be four-neighbour connected"
        )


def _require_no_holes(selected: np.ndarray) -> None:
    rows, columns = np.nonzero(selected)
    if not len(rows):
        return
    cropped = selected[
        rows.min():rows.max() + 1,
        columns.min():columns.max() + 1,
    ]
    outside = ~cropped
    visited = np.zeros_like(outside)
    pending = []
    for row in range(outside.shape[0]):
        pending.extend((row, column) for column in (0, outside.shape[1] - 1))
    for column in range(outside.shape[1]):
        pending.extend((row, column) for row in (0, outside.shape[0] - 1))
    while pending:
        row, column = pending.pop()
        if visited[row, column] or not outside[row, column]:
            continue
        visited[row, column] = True
        for neighbour_row, neighbour_column in (
            (row - 1, column),
            (row + 1, column),
            (row, column - 1),
            (row, column + 1),
        ):
            if (
                0 <= neighbour_row < outside.shape[0]
                and 0 <= neighbour_column < outside.shape[1]
            ):
                pending.append((neighbour_row, neighbour_column))
    if np.any(outside & ~visited):
        raise SimulationAreaError("simulation area holes are not supported")


def _area_hash(
    *,
    dataset_version: str,
    crs: str,
    shape: tuple[int, int],
    transform: tuple[float, ...],
    cell_indices: np.ndarray,
) -> str:
    canonical = json.dumps(
        {
            "datasetVersion": dataset_version,
            "crs": crs,
            "shape": shape,
            "transform": transform,
            "cellIndices": [int(value) for value in cell_indices],
            "meshRule": "square-sw-ne-v1",
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(canonical).hexdigest()
