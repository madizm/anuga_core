"""Loading and validation for Bayuquan's fixed model assets."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass(frozen=True)
class FixedModelPaths:
    mesh: Path
    mapping: Path
    raster_mapping: Path
    elevation: Path
    friction_low: Path
    friction_middle: Path
    friction_high: Path

    @classmethod
    def under(cls, project_root: Path | str) -> "FixedModelPaths":
        root = Path(project_root)
        model = root / "OUTPUT/model"
        mapping = model / "grid_mapping"
        return cls(
            mesh=mapping / "bayuquan_fixed_mesh.msh",
            mapping=mapping / "grid_triangle_mapping.npz",
            raster_mapping=mapping / "raster_interpolation_mapping.npz",
            elevation=model / "elevation_30m.asc",
            friction_low=model / "manning_low_30m.asc",
            friction_middle=model / "manning_middle_30m.asc",
            friction_high=model / "manning_high_30m.asc",
        )

    def friction(self, scenario: str) -> Path:
        return getattr(self, f"friction_{scenario}")


class AsciiGrid:
    """Small AAIGrid reader and ANUGA-compatible sampler."""

    def __init__(self, path: Path | str):
        self.path = Path(path)
        header: dict[str, float] = {}
        with self.path.open() as source:
            for _ in range(6):
                key, value = source.readline().split()[:2]
                header[key.lower()] = float(value)
        self.ncols = int(header["ncols"])
        self.nrows = int(header["nrows"])
        self.xll = header.get("xllcorner", header.get("xllcenter"))
        self.yll = header.get("yllcorner", header.get("yllcenter"))
        self.cellsize = header["cellsize"]
        self.nodata = header.get("nodata_value")
        self.values = np.loadtxt(self.path, skiprows=6)
        if self.values.shape != (self.nrows, self.ncols):
            raise ValueError(
                f"unexpected raster shape in {self.path}: {self.values.shape}"
            )

    def validate_mapping(self, mapping, name: str) -> None:
        actual = (
            self.nrows,
            self.ncols,
            self.cellsize,
            self.xll,
            self.yll,
        )
        expected = (
            mapping.nrows,
            mapping.ncols,
            mapping.cellsize,
            mapping.xllcorner,
            mapping.yllcorner,
        )
        if actual != expected:
            raise ValueError(
                f"{name} grid shape/resolution {actual} "
                f"does not match mapping {expected}"
            )

    def sampler(self, domain):
        x_offset = domain.geo_reference.xllcorner
        y_offset = domain.geo_reference.yllcorner

        def sample(x, y):
            absolute_x = np.asarray(x) + x_offset
            absolute_y = np.asarray(y) + y_offset
            columns = np.floor((absolute_x - self.xll) /
                               self.cellsize).astype(int)
            rows_from_bottom = np.floor(
                (absolute_y - self.yll) / self.cellsize
            ).astype(int)
            rows = self.nrows - 1 - rows_from_bottom
            if (
                np.any(columns < 0)
                or np.any(columns >= self.ncols)
                or np.any(rows < 0)
                or np.any(rows >= self.nrows)
            ):
                raise ValueError(f"mesh point lies outside {self.path}")
            result = self.values[rows, columns]
            if self.nodata is not None and np.any(result == self.nodata):
                raise ValueError(
                    f"mesh point intersects NoData in {self.path}")
            return result

        return sample
