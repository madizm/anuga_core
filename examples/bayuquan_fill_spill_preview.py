"""Run the non-authoritative Bayuquan fill-spill preview on one DEM window."""

from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from pathlib import Path

from rasterio.windows import Window

from bayuquan.preview.local_preview import run_local_preview


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


def _window(value: str) -> Window:
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
            "Run a non-authoritative CPU fill-spill preview for one bounded "
            "Bayuquan 5 m DEM window."
        ),
    )
    parser.add_argument(
        "--dem",
        type=Path,
        default=(
            REPOSITORY_ROOT / "OUTPUT/model/web/elevation_5m_cog.tif"
        ),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=(
            REPOSITORY_ROOT
            / "OUTPUT/preview/bayuquan-fill-spill-80mm.cog.tif"
        ),
    )
    parser.add_argument(
        "--preprocessing-cache",
        type=Path,
        default=(
            REPOSITORY_ROOT
            / "OUTPUT/preview/bayuquan-2413-1779-128.npz"
        ),
    )
    parser.add_argument(
        "--window",
        type=_window,
        default=Window(2413, 1779, 128, 128),
        help="bounded pixel window: col_off,row_off,width,height",
    )
    parser.add_argument(
        "--effective-rainfall-mm",
        type=float,
        default=80.0,
        help="uniform accumulated effective rainfall after losses",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    arguments = parser.parse_args(argv)
    if not arguments.dem.is_file():
        parser.error(f"5 m DEM is unavailable: {arguments.dem}")
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
