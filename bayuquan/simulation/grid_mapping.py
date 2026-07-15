"""Authoritative conversion from Bayuquan DEM cells to ANUGA triangles."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np


_CELL_ID = re.compile(r"^r(?P<row>\d{4})-c(?P<column>\d{4})$")


class GridMappingError(ValueError):
    """Raised when a grid mapping or selection violates the fixed model."""


@dataclass(frozen=True)
class GridSelection:
    """Resolved, normalized selection of fixed-model cells."""

    cell_ids: tuple[str, ...]
    triangle_ids: np.ndarray
    geometric_area_m2: float
    effective_triangle_area_m2: float


class GridTriangleMapping:
    """Validated runtime mapping between 30 m cells and mesh triangles."""

    def __init__(
        self,
        *,
        triangle_cell_index: np.ndarray,
        triangle_area_m2: np.ndarray,
        nrows: int,
        ncols: int,
        cellsize: float,
        xllcorner: float,
        yllcorner: float,
        mesh_sha256: str,
    ) -> None:
        self.triangle_cell_index = np.asarray(
            triangle_cell_index, dtype=np.int32
        )
        self.triangle_area_m2 = np.asarray(triangle_area_m2, dtype=float)
        self.nrows = int(nrows)
        self.ncols = int(ncols)
        self.cellsize = float(cellsize)
        self.xllcorner = float(xllcorner)
        self.yllcorner = float(yllcorner)
        self.mesh_sha256 = str(mesh_sha256)

        if self.triangle_cell_index.ndim != 1:
            raise GridMappingError(
                "triangle_cell_index must be one-dimensional")
        if self.triangle_area_m2.shape != self.triangle_cell_index.shape:
            raise GridMappingError(
                "triangle area and cell-index arrays differ in size")
        if self.nrows <= 0 or self.ncols <= 0 or self.cellsize <= 0:
            raise GridMappingError("invalid fixed-grid dimensions")
        if np.any(self.triangle_area_m2 <= 0):
            raise GridMappingError("triangle areas must be positive")
        if np.any(self.triangle_cell_index < 0) or np.any(
            self.triangle_cell_index >= self.nrows * self.ncols
        ):
            raise GridMappingError(
                "mapping refers to a cell outside the fixed grid")

        self._selectable = frozenset(
            int(index) for index in np.unique(self.triangle_cell_index)
        )

    @classmethod
    def load(cls, path: Path | str) -> "GridTriangleMapping":
        """Load a mapping NPZ without allowing pickled objects."""
        with np.load(path, allow_pickle=False) as data:
            required = {
                "triangle_cell_index",
                "triangle_area_m2",
                "nrows",
                "ncols",
                "cellsize",
                "xllcorner",
                "yllcorner",
                "mesh_sha256",
            }
            missing = required.difference(data.files)
            if missing:
                raise GridMappingError(
                    f"mapping is missing fields: {', '.join(sorted(missing))}"
                )
            return cls(
                triangle_cell_index=data["triangle_cell_index"],
                triangle_area_m2=data["triangle_area_m2"],
                nrows=int(data["nrows"]),
                ncols=int(data["ncols"]),
                cellsize=float(data["cellsize"]),
                xllcorner=float(data["xllcorner"]),
                yllcorner=float(data["yllcorner"]),
                mesh_sha256=str(data["mesh_sha256"].item()),
            )

    @staticmethod
    def file_sha256(path: Path | str) -> str:
        digest = hashlib.sha256()
        with Path(path).open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()

    def validate_mesh(
        self, mesh_path: Path | str, triangle_count: int
    ) -> None:
        """Fail fast if this mapping does not describe the loaded mesh."""
        actual_hash = self.file_sha256(mesh_path)
        if actual_hash != self.mesh_sha256:
            raise GridMappingError(
                "fixed mesh SHA-256 does not match grid mapping "
                f"({actual_hash} != {self.mesh_sha256})"
            )
        if triangle_count != len(self.triangle_cell_index):
            raise GridMappingError(
                "fixed mesh triangle count does not match grid mapping "
                f"({triangle_count} != {len(self.triangle_cell_index)})"
            )

    def parse_cell_id(self, value: str) -> tuple[int, int, int]:
        match = _CELL_ID.fullmatch(value)
        if match is None:
            raise GridMappingError(f"invalid cell ID: {value!r}")
        row = int(match.group("row"))
        column = int(match.group("column"))
        if not (0 <= row < self.nrows and 0 <= column < self.ncols):
            raise GridMappingError(
                f"cell ID is outside the fixed grid: {value}")
        linear_index = row * self.ncols + column
        if linear_index not in self._selectable:
            raise GridMappingError(f"cell is not selectable: {value}")
        return row, column, linear_index

    def resolve(
        self, cell_ids: Iterable[str], *, require_connected: bool = True
    ) -> GridSelection:
        """Resolve IDs and optionally enforce four-neighbour connectivity."""
        values = tuple(cell_ids)
        if not values:
            raise GridMappingError("an inlet must contain at least one cell")
        if len(set(values)) != len(values):
            raise GridMappingError("an inlet contains duplicate cell IDs")

        parsed = [self.parse_cell_id(value) for value in values]
        linear_indices = {item[2] for item in parsed}
        if require_connected and not self._is_connected(linear_indices):
            raise GridMappingError(
                "inlet cells must be four-neighbour connected")

        normalized = tuple(
            f"r{index // self.ncols:04d}-c{index % self.ncols:04d}"
            for index in sorted(linear_indices)
        )
        selected = np.isin(
            self.triangle_cell_index,
            np.fromiter(linear_indices, dtype=np.int32),
        )
        triangle_ids = np.flatnonzero(selected).astype(np.int32)
        triangle_ids.setflags(write=False)
        return GridSelection(
            cell_ids=normalized,
            triangle_ids=triangle_ids,
            geometric_area_m2=len(linear_indices) * self.cellsize ** 2,
            effective_triangle_area_m2=float(
                self.triangle_area_m2[triangle_ids].sum()
            ),
        )

    def _is_connected(self, cells: set[int]) -> bool:
        pending = [next(iter(cells))]
        visited = {pending[0]}
        while pending:
            index = pending.pop()
            row, column = divmod(index, self.ncols)
            neighbours = []
            if row:
                neighbours.append(index - self.ncols)
            if row + 1 < self.nrows:
                neighbours.append(index + self.ncols)
            if column:
                neighbours.append(index - 1)
            if column + 1 < self.ncols:
                neighbours.append(index + 1)
            for neighbour in neighbours:
                if neighbour in cells and neighbour not in visited:
                    visited.add(neighbour)
                    pending.append(neighbour)
        return visited == cells
