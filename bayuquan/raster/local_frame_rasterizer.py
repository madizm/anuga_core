"""Direct cell aggregation for deterministic local structured meshes."""

from __future__ import annotations

import numpy as np

from bayuquan.simulation.area import SimulationArea

from .frame_rasterizer import RasterFrame
from .interpolation import RasterGrid


class LocalFrameRasterizer:
    """Aggregate each cell's two triangles into its aligned output pixel."""

    def __init__(
        self,
        area: SimulationArea,
        triangle_cell_index: np.ndarray,
        triangle_area_m2: np.ndarray,
        *,
        dry_depth_m: float = 0.01,
    ) -> None:
        self.area = area
        self.triangle_cell_index = np.asarray(
            triangle_cell_index, dtype=np.int64
        )
        self.triangle_area_m2 = np.asarray(triangle_area_m2, dtype=float)
        if self.triangle_cell_index.shape != self.triangle_area_m2.shape:
            raise ValueError("triangle cell and area arrays differ in size")
        row_start, row_stop, column_start, column_stop = area.window
        self.rows = row_stop - row_start
        self.columns = column_stop - column_start
        global_rows, global_columns = np.divmod(
            self.triangle_cell_index, area.ncols
        )
        local_rows = global_rows - row_start
        local_columns = global_columns - column_start
        if np.any(local_rows < 0) or np.any(local_rows >= self.rows):
            raise ValueError("triangle row falls outside area window")
        if np.any(local_columns < 0) or np.any(
            local_columns >= self.columns
        ):
            raise ValueError("triangle column falls outside area window")
        self.local_cell_index = (
            local_rows * self.columns + local_columns
        ).astype(np.int32)
        self.dry_depth_m = dry_depth_m
        a, _, c, _, e, f = area.transform
        upper_left_y = f + row_start * e
        self.grid = RasterGrid(
            rows=self.rows,
            columns=self.columns,
            cellsize=area.cell_size_m,
            xllcorner=c + column_start * a,
            yllcorner=upper_left_y - self.rows * area.cell_size_m,
            crs=area.crs,
        )

    def rasterize(self, domain, time_seconds: float) -> RasterFrame:
        elevation = np.asarray(
            domain.quantities["elevation"].centroid_values, dtype=float
        )
        stage = np.asarray(
            domain.quantities["stage"].centroid_values, dtype=float
        )
        depth = np.maximum(stage - elevation, 0.0)
        momentum = np.hypot(
            domain.quantities["xmomentum"].centroid_values,
            domain.quantities["ymomentum"].centroid_values,
        )
        speed = np.divide(
            momentum,
            depth,
            out=np.zeros_like(depth),
            where=depth >= 1.0e-6,
        )
        values = np.stack([
            self._aggregate(depth),
            self._aggregate(stage),
            self._aggregate(speed),
        ]).astype(np.float32)
        valid = np.isfinite(values).all(axis=0)
        display_mask = valid & (values[0] >= self.dry_depth_m)
        return RasterFrame(
            time_seconds=float(time_seconds),
            values=values,
            display_mask=display_mask,
            maximum_depth_m=(
                float(values[0, valid].max()) if np.any(valid) else 0.0
            ),
            maximum_speed_mps=(
                float(values[2, valid].max()) if np.any(valid) else 0.0
            ),
            wet_area_m2=float(
                display_mask.sum() * self.area.cell_size_m ** 2
            ),
        )

    def _aggregate(self, triangle_values: np.ndarray) -> np.ndarray:
        weighted = np.bincount(
            self.local_cell_index,
            weights=triangle_values * self.triangle_area_m2,
            minlength=self.rows * self.columns,
        )
        areas = np.bincount(
            self.local_cell_index,
            weights=self.triangle_area_m2,
            minlength=self.rows * self.columns,
        )
        result = np.full(self.rows * self.columns, np.nan, dtype=float)
        np.divide(weighted, areas, out=result, where=areas > 0)
        return result.reshape(self.rows, self.columns)
