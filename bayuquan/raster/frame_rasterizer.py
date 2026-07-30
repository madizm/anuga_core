"""Rasterize one evolved ANUGA state onto the fixed 30 m output grid."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .interpolation import RasterInterpolationMapping


@dataclass(frozen=True)
class RasterFrame:
    time_seconds: float
    values: np.ndarray
    display_mask: np.ndarray
    maximum_depth_m: float
    maximum_speed_mps: float
    wet_area_m2: float


class FrameRasterizer:
    """Fast per-frame interpolation using a precomputed fixed mapping."""

    band_names = ("depth", "stage", "speed", "velocity_u", "velocity_v")
    band_units = ("m", "m", "m/s", "m/s", "m/s")

    def __init__(
        self,
        mapping: RasterInterpolationMapping,
        *,
        dry_depth_m: float = 0.01,
        velocity_epsilon_m: float = 1.0e-6,
    ) -> None:
        if dry_depth_m < 0 or velocity_epsilon_m <= 0:
            raise ValueError("invalid rasterization thresholds")
        self.mapping = mapping
        self.dry_depth_m = dry_depth_m
        self.velocity_epsilon_m = velocity_epsilon_m

    def rasterize(self, domain, time_seconds: float) -> RasterFrame:
        """Interpolate depth, absolute stage, and speed for one frame."""
        triangle_index = self.mapping.triangle_index
        valid = triangle_index >= 0
        values = {}
        for name in ("stage", "elevation", "xmomentum", "ymomentum"):
            vertices = np.asarray(domain.quantities[name].vertex_values)
            if vertices.ndim != 2 or vertices.shape[1] != 3:
                raise ValueError(
                    f"{name} vertex values must have shape (N, 3)"
                )
            maximum_index = (
                int(triangle_index[valid].max()) if np.any(valid) else -1
            )
            if maximum_index >= len(vertices):
                raise ValueError(
                    "raster mapping does not match domain triangles"
                )
            interpolated = np.full(len(triangle_index), np.nan, dtype=float)
            ids = triangle_index[valid]
            interpolated[valid] = np.einsum(
                "ij,ij->i",
                vertices[ids],
                self.mapping.barycentric_weights[valid],
            )
            values[name] = interpolated

        depth = np.maximum(values["stage"] - values["elevation"], 0.0)
        velocity_u = np.zeros_like(depth)
        velocity_v = np.zeros_like(depth)
        velocity_valid = valid & (depth >= self.velocity_epsilon_m)
        np.divide(
            values["xmomentum"], depth,
            out=velocity_u, where=velocity_valid,
        )
        np.divide(
            values["ymomentum"], depth,
            out=velocity_v, where=velocity_valid,
        )
        speed = np.hypot(velocity_u, velocity_v)
        if not all(np.all(np.isfinite(value[valid])) for value in (
            depth, values["stage"], speed, velocity_u, velocity_v
        )):
            raise ValueError("frame contains NaN or infinite values")

        shape = (self.mapping.grid.rows, self.mapping.grid.columns)
        frame_values = np.stack((
            depth.reshape(shape),
            values["stage"].reshape(shape),
            speed.reshape(shape),
            velocity_u.reshape(shape),
            velocity_v.reshape(shape),
        )).astype(np.float32)
        valid_grid = valid.reshape(shape)
        display_mask = valid_grid & (frame_values[0] >= self.dry_depth_m)
        return RasterFrame(
            time_seconds=float(time_seconds),
            values=frame_values,
            display_mask=display_mask,
            maximum_depth_m=(
                float(depth[valid].max()) if np.any(valid) else 0.0
            ),
            maximum_speed_mps=(
                float(speed[valid].max()) if np.any(valid) else 0.0
            ),
            wet_area_m2=float(
                display_mask.sum() * self.mapping.grid.cellsize ** 2
            ),
        )
