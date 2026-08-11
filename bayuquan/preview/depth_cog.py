"""Streaming Cloud Optimized GeoTIFF output for fill-spill previews."""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio

from .fill_spill import FillSpillResult

NODATA = -9999.0
DEFAULT_THRESHOLDS_M = (0.05, 0.15, 0.30, 0.50, 1.00)


@dataclass(frozen=True)
class WrittenDepthCog:
    """Published COG path and impact summary."""

    path: Path
    size_bytes: int
    maximum_depth_m: float
    wet_area_m2: float
    threshold_areas_m2: dict[float, float]


def _temporary_path(directory: Path) -> Path:
    descriptor, name = tempfile.mkstemp(dir=directory, suffix=".cog.tif")
    os.close(descriptor)
    path = Path(name)
    path.unlink()
    return path


def _validate_cog(
    path: Path,
    *,
    shape: tuple[int, int],
    crs: object,
    transform: object,
) -> None:
    with rasterio.open(path) as dataset:
        if dataset.shape != shape:
            raise ValueError("maximum-depth COG dimensions do not match DEM")
        if dataset.crs != crs:
            raise ValueError("maximum-depth COG CRS does not match DEM")
        if dataset.transform != transform:
            raise ValueError("maximum-depth COG transform does not match DEM")
        if dataset.count != 1 or dataset.dtypes != ("float32",):
            raise ValueError("maximum-depth COG must contain one Float32 band")
        if dataset.nodata != NODATA:
            raise ValueError("maximum-depth COG NoData value is invalid")
        if dataset.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") != "COG":
            raise ValueError("maximum-depth output is not a COG")


def write_maximum_depth_cog(
    *,
    dem_path: Path | str,
    basin_ids: np.ndarray,
    result: FillSpillResult,
    destination: Path | str,
    source_window: rasterio.windows.Window | None = None,
    thresholds_m: tuple[float, ...] = DEFAULT_THRESHOLDS_M,
    compression: str = "DEFLATE",
) -> WrittenDepthCog:
    """Restore and atomically publish maximum depth one raster block at a time.

    Valid DEM cells outside a depression are written as zero depth. DEM NoData
    cells remain NoData. Only a source block, a basin-ID block, and an output
    block are resident in the writer at any time.
    """
    target = Path(destination)
    target.parent.mkdir(parents=True, exist_ok=True)
    ids = np.asarray(basin_ids)
    if ids.ndim != 2:
        raise ValueError("basin IDs must be a two-dimensional array")
    if any(not np.isfinite(item) or item <= 0.0 for item in thresholds_m):
        raise ValueError("depth thresholds must be finite and greater than zero")
    thresholds = tuple(sorted({float(item) for item in thresholds_m}))
    compression = compression.upper()
    if compression not in {"DEFLATE", "ZSTD"}:
        raise ValueError("COG compression must be DEFLATE or ZSTD")

    temporary = _temporary_path(target.parent)
    maximum_depth = 0.0
    wet_cells = 0
    threshold_cells = {item: 0 for item in thresholds}
    try:
        with rasterio.open(dem_path) as source:
            if source.count < 1:
                raise ValueError("DEM must contain an elevation band")
            if source_window is None:
                source_window = rasterio.windows.Window(
                    0,
                    0,
                    source.width,
                    source.height,
                )
            source_window = source_window.round_offsets().round_lengths()
            if (
                source_window.col_off < 0
                or source_window.row_off < 0
                or source_window.col_off + source_window.width > source.width
                or source_window.row_off + source_window.height > source.height
            ):
                raise ValueError("source window must be within DEM bounds")
            output_shape = (
                int(source_window.height),
                int(source_window.width),
            )
            if ids.shape != output_shape:
                raise ValueError("basin IDs must match DEM dimensions")
            transform = source.window_transform(source_window)
            cell_area = abs(
                transform.a * transform.e - transform.b * transform.d
            )
            profile = {
                "driver": "COG",
                "width": output_shape[1],
                "height": output_shape[0],
                "count": 1,
                "dtype": "float32",
                "crs": source.crs,
                "transform": transform,
                "nodata": NODATA,
                "blocksize": 256,
                "compress": compression,
                "overviews": "AUTO",
            }
            with rasterio.open(temporary, "w", **profile) as output:
                for _, window in output.block_windows(1):
                    row_start = int(window.row_off)
                    row_stop = row_start + int(window.height)
                    column_start = int(window.col_off)
                    column_stop = column_start + int(window.width)
                    dem_window = rasterio.windows.Window(
                        source_window.col_off + window.col_off,
                        source_window.row_off + window.row_off,
                        window.width,
                        window.height,
                    )
                    elevation_values = source.read(
                        1,
                        window=dem_window,
                        out_dtype="float64",
                    )
                    source_mask = source.read_masks(1, window=dem_window)
                    valid = (source_mask > 0) & np.isfinite(elevation_values)
                    depth = result.depths_for(
                        ids[row_start:row_stop, column_start:column_stop],
                        elevation_values,
                    )
                    depth[valid & ~np.isfinite(depth)] = 0.0
                    depth[~valid] = NODATA
                    output.write(depth, 1, window=window)

                    valid_depths = depth[valid]
                    if valid_depths.size:
                        maximum_depth = max(
                            maximum_depth,
                            float(np.max(valid_depths)),
                        )
                        wet_cells += int(np.count_nonzero(valid_depths > 0.0))
                        for threshold in thresholds:
                            threshold_cells[threshold] += int(
                                np.count_nonzero(valid_depths >= threshold)
                            )
                output.descriptions = ("maximum_water_depth",)
                output.units = ("m",)
                output.update_tags(
                    preview_authority="non-authoritative",
                    preview_quantity="maximum_water_depth",
                    maximum_depth_m=f"{maximum_depth:.9g}",
                    wet_area_m2=f"{wet_cells * cell_area:.9g}",
                    input_volume_m3=f"{result.input_volume_m3:.9g}",
                    retained_volume_m3=f"{result.retained_volume_m3:.9g}",
                    outflow_volume_m3=f"{result.outflow_volume_m3:.9g}",
                    mass_balance_error_m3=(
                        f"{result.mass_balance_error_m3:.9g}"
                    ),
                )
                output.update_tags(**{
                    f"area_ge_{threshold:.2f}_m_m2".replace(".", "_"):
                    f"{threshold_cells[threshold] * cell_area:.9g}"
                    for threshold in thresholds
                })
            _validate_cog(
                temporary,
                shape=output_shape,
                crs=source.crs,
                transform=transform,
            )
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)

    return WrittenDepthCog(
        path=target,
        size_bytes=target.stat().st_size,
        maximum_depth_m=maximum_depth,
        wet_area_m2=wet_cells * cell_area,
        threshold_areas_m2={
            threshold: count * cell_area
            for threshold, count in threshold_cells.items()
        },
    )
