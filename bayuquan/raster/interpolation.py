"""Precomputed interpolation from the fixed ANUGA mesh to the DEM grid."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from bayuquan.simulation.grid_mapping import GridTriangleMapping


class RasterMappingError(ValueError):
    """Raised when a raster interpolation mapping is invalid or stale."""


@dataclass(frozen=True)
class RasterGrid:
    rows: int
    columns: int
    cellsize: float
    xllcorner: float
    yllcorner: float
    crs: str = "EPSG:32651"

    @property
    def upper_left_y(self) -> float:
        return self.yllcorner + self.rows * self.cellsize

    @property
    def transform_tuple(self) -> tuple[float, ...]:
        return (
            self.cellsize,
            0.0,
            self.xllcorner,
            0.0,
            -self.cellsize,
            self.upper_left_y,
        )

    def pixel_centres(self) -> np.ndarray:
        columns = self.xllcorner + (
            np.arange(self.columns, dtype=float) + 0.5
        ) * self.cellsize
        rows = self.upper_left_y - (
            np.arange(self.rows, dtype=float) + 0.5
        ) * self.cellsize
        x, y = np.meshgrid(columns, rows)
        return np.column_stack((x.ravel(), y.ravel()))


@dataclass(frozen=True)
class RasterInterpolationMapping:
    grid: RasterGrid
    triangle_index: np.ndarray
    barycentric_weights: np.ndarray
    mesh_sha256: str

    def __post_init__(self) -> None:
        pixel_count = self.grid.rows * self.grid.columns
        triangles = np.asarray(self.triangle_index, dtype=np.int32)
        weights = np.asarray(self.barycentric_weights, dtype=float)
        if triangles.shape != (pixel_count,):
            raise RasterMappingError("triangle index size does not match grid")
        if weights.shape != (pixel_count, 3):
            raise RasterMappingError(
                "barycentric weights size does not match grid"
            )
        valid = triangles >= 0
        if np.any(~np.isfinite(weights[valid])):
            raise RasterMappingError("valid pixels contain non-finite weights")
        if np.any(np.abs(weights[valid].sum(axis=1) - 1.0) > 1.0e-9):
            raise RasterMappingError("barycentric weights do not sum to one")
        triangles.setflags(write=False)
        weights.setflags(write=False)
        object.__setattr__(self, "triangle_index", triangles)
        object.__setattr__(self, "barycentric_weights", weights)

    @property
    def valid_mask(self) -> np.ndarray:
        return (self.triangle_index >= 0).reshape(
            self.grid.rows, self.grid.columns
        )

    @classmethod
    def load(
        cls,
        path: Path | str,
        *,
        mesh_path: Path | str | None = None,
        triangle_count: int | None = None,
    ) -> "RasterInterpolationMapping":
        with np.load(path, allow_pickle=False) as data:
            required = {
                "triangle_index",
                "barycentric_weights",
                "rows",
                "columns",
                "cellsize",
                "xllcorner",
                "yllcorner",
                "crs",
                "mesh_sha256",
            }
            missing = required.difference(data.files)
            if missing:
                raise RasterMappingError(
                    f"raster mapping is missing: {', '.join(sorted(missing))}"
                )
            result = cls(
                grid=RasterGrid(
                    rows=int(data["rows"]),
                    columns=int(data["columns"]),
                    cellsize=float(data["cellsize"]),
                    xllcorner=float(data["xllcorner"]),
                    yllcorner=float(data["yllcorner"]),
                    crs=str(data["crs"].item()),
                ),
                triangle_index=data["triangle_index"],
                barycentric_weights=data["barycentric_weights"],
                mesh_sha256=str(data["mesh_sha256"].item()),
            )
        if mesh_path is not None:
            actual = GridTriangleMapping.file_sha256(mesh_path)
            if actual != result.mesh_sha256:
                raise RasterMappingError(
                    "mesh SHA-256 does not match raster mapping"
                )
        if triangle_count is not None:
            valid = result.triangle_index[result.triangle_index >= 0]
            if len(valid) and int(valid.max()) >= triangle_count:
                raise RasterMappingError(
                    "raster mapping refers to a missing triangle"
                )
        return result

    def save(self, path: Path | str) -> None:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            target,
            triangle_index=self.triangle_index,
            barycentric_weights=self.barycentric_weights,
            rows=np.int32(self.grid.rows),
            columns=np.int32(self.grid.columns),
            cellsize=np.float64(self.grid.cellsize),
            xllcorner=np.float64(self.grid.xllcorner),
            yllcorner=np.float64(self.grid.yllcorner),
            transform=np.asarray(self.grid.transform_tuple, dtype=np.float64),
            crs=np.array(self.grid.crs),
            mesh_sha256=np.array(self.mesh_sha256),
        )


def build_interpolation_mapping(
    triangle_vertices: np.ndarray,
    grid: RasterGrid,
    mesh_sha256: str,
    *,
    tolerance: float = 1.0e-10,
) -> RasterInterpolationMapping:
    """Locate each pixel centre and calculate its triangle vertex weights."""
    vertices = np.asarray(triangle_vertices, dtype=float)
    if vertices.ndim != 3 or vertices.shape[1:] != (3, 2):
        raise RasterMappingError("triangle vertices must have shape (N, 3, 2)")
    points = grid.pixel_centres()
    triangle_index = np.full(len(points), -1, dtype=np.int32)
    weights = np.full((len(points), 3), np.nan, dtype=float)

    xmin = vertices[:, :, 0].min(axis=1)
    xmax = vertices[:, :, 0].max(axis=1)
    ymin = vertices[:, :, 1].min(axis=1)
    ymax = vertices[:, :, 1].max(axis=1)

    for pixel, (x, y) in enumerate(points):
        candidates = np.flatnonzero(
            (x >= xmin - tolerance)
            & (x <= xmax + tolerance)
            & (y >= ymin - tolerance)
            & (y <= ymax + tolerance)
        )
        for triangle in candidates:
            barycentric = _barycentric(vertices[triangle], x, y)
            if (
                barycentric is not None
                and np.all(barycentric >= -tolerance)
                and np.all(barycentric <= 1.0 + tolerance)
            ):
                barycentric = np.clip(barycentric, 0.0, 1.0)
                barycentric /= barycentric.sum()
                triangle_index[pixel] = triangle
                weights[pixel] = barycentric
                break

    return RasterInterpolationMapping(
        grid=grid,
        triangle_index=triangle_index,
        barycentric_weights=weights,
        mesh_sha256=mesh_sha256,
    )


def _barycentric(vertices: np.ndarray, x: float, y: float):
    a, b, c = vertices
    denominator = ((b[1] - c[1]) * (a[0] - c[0])
                   + (c[0] - b[0]) * (a[1] - c[1]))
    if abs(denominator) < 1.0e-20:
        return None
    first = ((b[1] - c[1]) * (x - c[0])
             + (c[0] - b[0]) * (y - c[1])) / denominator
    second = ((c[1] - a[1]) * (x - c[0])
              + (a[0] - c[0]) * (y - c[1])) / denominator
    return np.array([first, second, 1.0 - first - second], dtype=float)
