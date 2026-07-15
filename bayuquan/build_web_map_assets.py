#!/usr/bin/env python3
"""Build immutable, web-optimized raster assets for the fixed model."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from tempfile import NamedTemporaryFile

import fiona
import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.shutil import copy as copy_raster
from rasterio.transform import Affine
from rasterio.windows import bounds as window_bounds
from rasterio.windows import transform as window_transform


MODEL_INPUT_ALGORITHM = "building-supersample-3m-v1"
MODEL_INPUT_DESCRIPTIONS = (
    "building_fraction",
    "building_density_class",
    "manning_low",
    "manning_middle",
    "manning_high",
)
MANNING_VALUES = np.array([
    [0.03, 0.04, 0.06, 0.08, 0.10],
    [0.04, 0.05, 0.08, 0.12, 0.16],
    [0.05, 0.07, 0.10, 0.16, 0.20],
], dtype=np.float32)
MODEL_NODATA = -9999.0


def is_current_cog(source: Path, target: Path) -> bool:
    source_is_newer = (
        target.exists()
        and target.stat().st_mtime_ns < source.stat().st_mtime_ns
    )
    if not target.exists() or source_is_newer:
        return False
    try:
        with rasterio.open(target) as dataset:
            block_height, block_width = dataset.block_shapes[0]
            tiled = (
                block_height < dataset.height and block_width < dataset.width
            )
            return tiled and bool(dataset.overviews(1))
    except rasterio.errors.RasterioError:
        return False


def build_dem_cog(source: Path, target: Path, *, force: bool = False) -> Path:
    source = source.resolve()
    target = target.resolve()
    if not source.is_file():
        raise FileNotFoundError(f"DEM source not found: {source}")
    if not force and is_current_cog(source, target):
        return target

    target.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(
        dir=target.parent,
        prefix=f".{target.stem}-",
        suffix=".tif",
        delete=False,
    ) as temporary:
        temporary_path = Path(temporary.name)

    try:
        copy_raster(
            source,
            temporary_path,
            driver="COG",
            BLOCKSIZE=512,
            COMPRESS="DEFLATE",
            PREDICTOR="YES",
            OVERVIEW_RESAMPLING="BILINEAR",
            BIGTIFF="IF_SAFER",
            NUM_THREADS="ALL_CPUS",
        )
        with rasterio.open(temporary_path) as dataset:
            block_height, block_width = dataset.block_shapes[0]
            tiled = (
                block_height < dataset.height and block_width < dataset.width
            )
            if not tiled or not dataset.overviews(1):
                raise RuntimeError(
                    "generated DEM is not a tiled COG with overviews"
                )
        temporary_path.chmod(0o644)
        os.replace(temporary_path, target)
    finally:
        temporary_path.unlink(missing_ok=True)
    return target


def build_model_inputs_cog(
    dem_path: Path,
    buildings_path: Path,
    target: Path,
    *,
    force: bool = False,
) -> Path:
    """Build full-DEM building and Manning bands as one atomic COG."""
    dem_path = dem_path.resolve()
    buildings_path = buildings_path.resolve()
    target = target.resolve()
    for source in (dem_path, buildings_path):
        if not source.is_file():
            raise FileNotFoundError(f"model input source not found: {source}")
    version = _model_input_version(dem_path, buildings_path)
    if not force and _is_current_model_inputs(target, version):
        return target

    target.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(
        dir=target.parent,
        prefix=f".{target.stem}-source-",
        suffix=".tif",
        delete=False,
    ) as temporary:
        temporary_path = Path(temporary.name)
    with NamedTemporaryFile(
        dir=target.parent,
        prefix=f".{target.stem}-cog-",
        suffix=".tif",
        delete=False,
    ) as cog_temporary:
        cog_temporary_path = Path(cog_temporary.name)

    try:
        _write_model_input_source(
            dem_path, buildings_path, temporary_path, version
        )
        copy_raster(
            temporary_path,
            cog_temporary_path,
            driver="COG",
            BLOCKSIZE=512,
            COMPRESS="DEFLATE",
            PREDICTOR="YES",
            OVERVIEW_RESAMPLING="NEAREST",
            BIGTIFF="IF_SAFER",
            NUM_THREADS="ALL_CPUS",
        )
        with rasterio.open(cog_temporary_path) as dataset:
            if dataset.tags().get("MODEL_INPUT_VERSION") != version:
                raise RuntimeError("generated model-input COG lost its version")
            if dataset.descriptions != MODEL_INPUT_DESCRIPTIONS:
                raise RuntimeError("generated model-input COG lost band metadata")
        cog_temporary_path.chmod(0o644)
        os.replace(cog_temporary_path, target)
    finally:
        temporary_path.unlink(missing_ok=True)
        cog_temporary_path.unlink(missing_ok=True)
    return target


def _write_model_input_source(
    dem_path: Path,
    buildings_path: Path,
    target: Path,
    version: str,
) -> None:
    with rasterio.open(dem_path) as dem, fiona.open(
        buildings_path, layer="building_footprints"
    ) as buildings:
        if dem.crs is None:
            raise ValueError("DEM has no CRS")
        building_crs = rasterio.crs.CRS.from_user_input(
            buildings.crs_wkt or buildings.crs
        )
        if building_crs != dem.crs:
            raise ValueError("building footprints are not aligned with DEM CRS")
        if not np.isclose(abs(dem.transform.a), 30) or not np.isclose(
            abs(dem.transform.e), 30
        ):
            raise ValueError("model-input builder requires a 30 m DEM")

        profile = dem.profile.copy()
        tiled = dem.width >= 16 and dem.height >= 16
        profile.update(
            driver="GTiff",
            count=len(MODEL_INPUT_DESCRIPTIONS),
            dtype="float32",
            nodata=MODEL_NODATA,
            compress="DEFLATE",
            predictor=3,
            tiled=tiled,
            BIGTIFF="IF_SAFER",
        )
        if tiled:
            profile.update(blockxsize=512, blockysize=512)
        else:
            profile.pop("blockxsize", None)
            profile.pop("blockysize", None)

        with rasterio.open(target, "w", **profile) as output:
            output.descriptions = MODEL_INPUT_DESCRIPTIONS
            output.update_tags(
                MODEL_INPUT_VERSION=version,
                MODEL_INPUT_ALGORITHM=MODEL_INPUT_ALGORITHM,
                BUILDING_OUTSIDE_COVERAGE="zero",
            )
            building_bounds = tuple(buildings.bounds)
            for _, window in output.block_windows(1):
                dem_values = dem.read(1, window=window, masked=True)
                valid = ~np.ma.getmaskarray(dem_values)
                fraction = _building_fraction(
                    buildings,
                    window,
                    dem.transform,
                    building_bounds,
                )
                density = np.digitize(
                    fraction, [0.05, 0.15, 0.30, 0.50]
                ).astype(np.float32)
                data = np.empty(
                    (len(MODEL_INPUT_DESCRIPTIONS), *fraction.shape),
                    dtype=np.float32,
                )
                data[0] = fraction
                data[1] = density
                data[2:] = MANNING_VALUES[:, density.astype(np.int8)]
                data[:, ~valid] = MODEL_NODATA
                output.write(data, window=window)


def _building_fraction(
    buildings,
    window,
    dem_transform,
    building_bounds: tuple[float, float, float, float],
) -> np.ndarray:
    height = int(window.height)
    width = int(window.width)
    result = np.zeros((height, width), dtype=np.float32)
    bounds = window_bounds(window, dem_transform)
    if not _bounds_intersect(bounds, building_bounds):
        return result
    geometries = [
        feature["geometry"]
        for feature in buildings.filter(bbox=bounds)
        if feature["geometry"] is not None
    ]
    if not geometries:
        return result
    supersampling = 10
    high_resolution = rasterize(
        ((geometry, 1) for geometry in geometries),
        out_shape=(height * supersampling, width * supersampling),
        transform=window_transform(window, dem_transform)
        * Affine.scale(1 / supersampling, 1 / supersampling),
        fill=0,
        dtype="uint8",
    )
    result = high_resolution.reshape(
        height, supersampling, width, supersampling
    ).mean(axis=(1, 3), dtype=np.float32)
    return np.round(result, 2)


def _bounds_intersect(first, second) -> bool:
    return not (
        first[2] <= second[0]
        or first[0] >= second[2]
        or first[3] <= second[1]
        or first[1] >= second[3]
    )


def _model_input_version(dem_path: Path, buildings_path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(json.dumps({
        "algorithm": MODEL_INPUT_ALGORITHM,
        "densityThresholds": [0.05, 0.15, 0.30, 0.50],
        "manning": MANNING_VALUES.tolist(),
        "outsideBuildingCoverage": "zero",
    }, sort_keys=True, separators=(",", ":")).encode())
    for path in (dem_path, buildings_path):
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
    return digest.hexdigest()


def _is_current_model_inputs(target: Path, version: str) -> bool:
    if not target.is_file():
        return False
    try:
        with rasterio.open(target) as dataset:
            return (
                dataset.tags().get("MODEL_INPUT_VERSION") == version
                and dataset.descriptions == MODEL_INPUT_DESCRIPTIONS
            )
    except rasterio.errors.RasterioError:
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--buildings", type=Path)
    parser.add_argument("--model-inputs-target", type=Path)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    result = build_dem_cog(args.source, args.target, force=args.force)
    print(result)
    if (args.buildings is None) != (args.model_inputs_target is None):
        parser.error(
            "--buildings and --model-inputs-target must be provided together"
        )
    if args.buildings is not None:
        model_inputs = build_model_inputs_cog(
            args.source,
            args.buildings,
            args.model_inputs_target,
            force=args.force,
        )
        print(model_inputs)


if __name__ == "__main__":
    main()
