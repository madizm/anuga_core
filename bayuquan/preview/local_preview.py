"""Local command-line entry point for a small fill-spill preview window."""

from __future__ import annotations

import argparse
import json
import math
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window

from .cache import (
    PreprocessingCacheMismatch,
    cache_identity,
    load_preprocessed,
    save_preprocessed,
)
from .depth_cog import WrittenDepthCog, write_maximum_depth_cog
from .preprocessing import preprocess_dem


@dataclass(frozen=True)
class LocalPreviewSummary:
    """Runtime and output summary for one local preview."""

    dem_path: Path
    output_path: Path
    window: Window
    effective_rainfall_mm: float
    depression_count: int
    input_volume_m3: float
    retained_volume_m3: float
    outflow_volume_m3: float
    mass_balance_error_m3: float
    written_cog: WrittenDepthCog
    preprocessing_cache_reused: bool

    def as_dict(self) -> dict:
        """Return the stable JSON-facing summary representation."""
        return {
            "demPath": str(self.dem_path),
            "outputPath": str(self.output_path),
            "window": {
                "columnOffset": int(self.window.col_off),
                "rowOffset": int(self.window.row_off),
                "width": int(self.window.width),
                "height": int(self.window.height),
            },
            "effectiveRainfallMm": self.effective_rainfall_mm,
            "depressionCount": self.depression_count,
            "inputVolumeM3": self.input_volume_m3,
            "retainedVolumeM3": self.retained_volume_m3,
            "outflowVolumeM3": self.outflow_volume_m3,
            "massBalanceErrorM3": self.mass_balance_error_m3,
            "preprocessingCacheReused": self.preprocessing_cache_reused,
            "maximumDepthM": self.written_cog.maximum_depth_m,
            "wetAreaM2": self.written_cog.wet_area_m2,
            "thresholdAreasM2": {
                format(threshold, ".2f"): area
                for threshold, area in (
                    self.written_cog.threshold_areas_m2.items()
                )
            },
            "sizeBytes": self.written_cog.size_bytes,
            "authority": "non-authoritative",
        }


def _normalise_window(
    source: rasterio.DatasetReader,
    window: Window | None,
) -> Window:
    if window is None:
        return Window(0, 0, source.width, source.height)
    result = window.round_offsets().round_lengths()
    if result.width <= 0 or result.height <= 0:
        raise ValueError("preview window width and height must be positive")
    if (
        result.col_off < 0
        or result.row_off < 0
        or result.col_off + result.width > source.width
        or result.row_off + result.height > source.height
    ):
        raise ValueError("preview window must be within DEM bounds")
    return result


def run_local_preview(
    *,
    dem_path: Path | str,
    destination: Path | str,
    effective_rainfall_mm: float,
    window: Window | None = None,
    preprocessing_cache: Path | str | None = None,
) -> LocalPreviewSummary:
    """Preprocess, solve, and write one small DEM window.

    ``effective_rainfall_mm`` is already net of infiltration and other losses;
    this function does not interpret it as raw precipitation.
    """
    if (
        not math.isfinite(effective_rainfall_mm)
        or effective_rainfall_mm < 0.0
    ):
        raise ValueError("effective rainfall must be finite and non-negative")

    source_path = Path(dem_path)
    output_path = Path(destination)
    with rasterio.open(source_path) as source:
        source_window = _normalise_window(source, window)
        elevations = source.read(1, window=source_window).astype(
            np.float64,
            copy=False,
        )
        valid = source.read_masks(1, window=source_window) > 0
        valid &= np.isfinite(elevations)
        transform = source.window_transform(source_window)
        cell_area = abs(
            transform.a * transform.e - transform.b * transform.d
        )
        if not math.isfinite(cell_area) or cell_area <= 0.0:
            raise ValueError("DEM transform must define a positive cell area")

        identity = cache_identity(
            dem_path=source_path,
            window=(
                int(source_window.col_off),
                int(source_window.row_off),
                int(source_window.width),
                int(source_window.height),
            ),
            transform=tuple(transform),
        )

    cache_path = None if preprocessing_cache is None else Path(
        preprocessing_cache
    )
    cache_reused = False
    if cache_path is not None and cache_path.exists():
        try:
            preprocessed = load_preprocessed(
                cache_path,
                expected_identity=identity,
            )
            cache_reused = True
        except PreprocessingCacheMismatch:
            preprocessed = preprocess_dem(
                elevations,
                cell_area_m2=cell_area,
                valid_mask=valid,
            )
            save_preprocessed(cache_path, preprocessed, identity=identity)
    else:
        preprocessed = preprocess_dem(
            elevations,
            cell_area_m2=cell_area,
            valid_mask=valid,
        )
        if cache_path is not None:
            save_preprocessed(cache_path, preprocessed, identity=identity)
    result = preprocessed.network.solve(
        effective_rainfall_depth_m=effective_rainfall_mm / 1000.0,
    )
    written = write_maximum_depth_cog(
        dem_path=source_path,
        source_window=source_window,
        basin_ids=preprocessed.basin_ids,
        result=result,
        destination=output_path,
    )
    return LocalPreviewSummary(
        dem_path=source_path,
        output_path=output_path,
        window=source_window,
        effective_rainfall_mm=effective_rainfall_mm,
        depression_count=len(preprocessed.depressions),
        input_volume_m3=result.input_volume_m3,
        retained_volume_m3=result.retained_volume_m3,
        outflow_volume_m3=result.outflow_volume_m3,
        mass_balance_error_m3=result.mass_balance_error_m3,
        written_cog=written,
        preprocessing_cache_reused=cache_reused,
    )


def _parse_window(value: str) -> Window:
    try:
        column, row, width, height = (
            int(item.strip()) for item in value.split(",")
        )
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError(
            "window must be col_off,row_off,width,height"
        ) from error
    if width <= 0 or height <= 0:
        raise argparse.ArgumentTypeError(
            "window width and height must be positive"
        )
    return Window(column, row, width, height)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Generate a non-authoritative fill-spill maximum-depth COG for "
            "one small DEM window."
        ),
    )
    parser.add_argument("dem", type=Path, help="input DEM Product raster")
    parser.add_argument("output", type=Path, help="output maximum-depth COG")
    parser.add_argument(
        "--effective-rainfall-mm",
        type=float,
        required=True,
        help="uniform accumulated rainfall after all losses, in millimetres",
    )
    parser.add_argument(
        "--window",
        type=_parse_window,
        required=True,
        help="pixel window: col_off,row_off,width,height",
    )
    parser.add_argument(
        "--preprocessing-cache",
        type=Path,
        help="optional reusable Priority-Flood cache (.npz)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the local preview CLI and print its JSON summary."""
    arguments = _parser().parse_args(argv)
    summary = run_local_preview(
        dem_path=arguments.dem,
        destination=arguments.output,
        effective_rainfall_mm=arguments.effective_rainfall_mm,
        window=arguments.window,
        preprocessing_cache=arguments.preprocessing_cache,
    )
    print(json.dumps(summary.as_dict(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
