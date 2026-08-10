#!/usr/bin/env python3
"""Build immutable, web-optimized raster assets for the fixed model."""

from __future__ import annotations

import argparse
import boto3
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
from rasterio.warp import (
    Resampling,
    calculate_default_transform,
    reproject,
)


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
DERIVED_SCALE = 3
DERIVED_DEM_ALGORITHM = "bilinear-30m-to-aligned-10m-v1"
DERIVED_INPUT_ALGORITHM = "nearest-replicate-30m-to-aligned-10m-v1"
REPROJECTED_DEM_ALGORITHM = "reprojected-dem-v1"


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


def build_reprojected_dem(
    source: Path,
    target: Path,
    *,
    target_crs: str,
    resolution_m: float,
    force: bool = False,
) -> Path:
    """Reproject a source DEM to the model CRS at a metric resolution."""
    source = source.resolve()
    target = target.resolve()
    if not source.is_file():
        raise FileNotFoundError(f"DEM source not found: {source}")
    if not force and is_current_cog(source, target):
        return target

    target.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(source) as source_dem:
        if source_dem.crs is None:
            raise ValueError("DEM source has no CRS")
        transform, width, height = calculate_default_transform(
            source_dem.crs,
            target_crs,
            source_dem.width,
            source_dem.height,
            *source_dem.bounds,
            resolution=(resolution_m, resolution_m),
        )
        profile = source_dem.profile.copy()
        profile.update(
            driver="GTiff",
            width=width,
            height=height,
            crs=target_crs,
            transform=transform,
            dtype="float32",
            nodata=MODEL_NODATA,
            compress="DEFLATE",
            predictor=3,
            tiled=True,
            blockxsize=512,
            blockysize=512,
            BIGTIFF="IF_SAFER",
        )
        with NamedTemporaryFile(
            dir=target.parent, prefix=f".{target.stem}-source-",
            suffix=".tif", delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
        with NamedTemporaryFile(
            dir=target.parent, prefix=f".{target.stem}-cog-",
            suffix=".tif", delete=False,
        ) as cog_temporary:
            cog_path = Path(cog_temporary.name)
        try:
            with rasterio.open(temporary_path, "w", **profile) as output:
                reproject(
                    source=rasterio.band(source_dem, 1),
                    destination=rasterio.band(output, 1),
                    src_transform=source_dem.transform,
                    src_crs=source_dem.crs,
                    src_nodata=source_dem.nodata,
                    dst_transform=transform,
                    dst_crs=target_crs,
                    dst_nodata=MODEL_NODATA,
                    resampling=Resampling.bilinear,
                    num_threads=2,
                )
                output.update_tags(
                    DERIVATION_ALGORITHM=REPROJECTED_DEM_ALGORITHM,
                    SOURCE_CRS=source_dem.crs.to_string(),
                    SOURCE_RESOLUTION_M=str(resolution_m),
                    EFFECTIVE_GRID_RESOLUTION_M=str(resolution_m),
                )
            copy_raster(
                temporary_path, cog_path, driver="COG", BLOCKSIZE=512,
                COMPRESS="DEFLATE", PREDICTOR="YES",
                OVERVIEW_RESAMPLING="BILINEAR", BIGTIFF="IF_SAFER",
                NUM_THREADS="ALL_CPUS",
            )
            cog_path.chmod(0o644)
            os.replace(cog_path, target)
        finally:
            temporary_path.unlink(missing_ok=True)
            cog_path.unlink(missing_ok=True)
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
        if not np.isclose(abs(dem.transform.a), abs(dem.transform.e)):
            raise ValueError("model-input builder requires square DEM cells")

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


def build_aligned_derived_dem(
    source: Path, target: Path, *, force: bool = False
) -> Path:
    """Build a 10 m DEM exactly nested inside a 30 m source grid."""
    if target.is_file() and not force:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(
        dir=target.parent, prefix=f".{target.stem}-source-",
        suffix=".tif", delete=False,
    ) as temporary:
        temporary_path = Path(temporary.name)
    with NamedTemporaryFile(
        dir=target.parent, prefix=f".{target.stem}-cog-",
        suffix=".tif", delete=False,
    ) as cog_temporary:
        cog_path = Path(cog_temporary.name)
    try:
        with rasterio.open(source) as source_dem:
            if not np.isclose(abs(source_dem.transform.a), 30):
                raise ValueError("derived DEM builder requires a 30 m source")
            profile = source_dem.profile.copy()
            profile.update(
                driver="GTiff",
                width=source_dem.width * DERIVED_SCALE,
                height=source_dem.height * DERIVED_SCALE,
                transform=source_dem.transform * Affine.scale(
                    1 / DERIVED_SCALE, 1 / DERIVED_SCALE
                ),
                dtype="float32",
                nodata=MODEL_NODATA,
                compress="DEFLATE",
                predictor=3,
                tiled=True,
                blockxsize=512,
                blockysize=512,
                BIGTIFF="IF_SAFER",
            )
            with rasterio.open(temporary_path, "w+", **profile) as output:
                reproject(
                    source=rasterio.band(source_dem, 1),
                    destination=rasterio.band(output, 1),
                    src_transform=source_dem.transform,
                    src_crs=source_dem.crs,
                    src_nodata=source_dem.nodata,
                    dst_transform=output.transform,
                    dst_crs=output.crs,
                    dst_nodata=output.nodata,
                    resampling=Resampling.bilinear,
                    num_threads=2,
                )
                # Never expand validity while interpolating. Every source mask
                # pixel maps to exactly one nested 3 x 3 output block.
                for _, window in output.block_windows(1):
                    row0, col0 = int(window.row_off), int(window.col_off)
                    row1 = row0 + int(window.height)
                    col1 = col0 + int(window.width)
                    source_window = rasterio.windows.Window(
                        col0 // DERIVED_SCALE,
                        row0 // DERIVED_SCALE,
                        (col1 - 1) // DERIVED_SCALE - col0 // DERIVED_SCALE + 1,
                        (row1 - 1) // DERIVED_SCALE - row0 // DERIVED_SCALE + 1,
                    )
                    valid = source_dem.read_masks(1, window=source_window) > 0
                    expanded = np.repeat(
                        np.repeat(valid, DERIVED_SCALE, axis=0),
                        DERIVED_SCALE, axis=1,
                    )
                    expanded = expanded[
                        row0 % DERIVED_SCALE:
                        row0 % DERIVED_SCALE + int(window.height),
                        col0 % DERIVED_SCALE:
                        col0 % DERIVED_SCALE + int(window.width),
                    ]
                    values = output.read(1, window=window)
                    values[~expanded] = output.nodata
                    output.write(values, 1, window=window)
                output.update_tags(
                    DERIVATION_ALGORITHM=DERIVED_DEM_ALGORITHM,
                    SOURCE_RESOLUTION_M="30",
                    EFFECTIVE_GRID_RESOLUTION_M="10",
                )
        copy_raster(
            temporary_path, cog_path, driver="COG", BLOCKSIZE=512,
            COMPRESS="DEFLATE", PREDICTOR="YES",
            OVERVIEW_RESAMPLING="BILINEAR", BIGTIFF="IF_SAFER",
            NUM_THREADS="ALL_CPUS",
        )
        cog_path.chmod(0o644)
        os.replace(cog_path, target)
    finally:
        temporary_path.unlink(missing_ok=True)
        cog_path.unlink(missing_ok=True)
    return target


def build_aligned_derived_inputs(
    source: Path, target: Path, *, force: bool = False
) -> Path:
    """Replicate each 30 m ancillary cell into a nested 3 x 3 block."""
    if target.is_file() and not force:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(
        dir=target.parent, prefix=f".{target.stem}-source-",
        suffix=".tif", delete=False,
    ) as temporary:
        temporary_path = Path(temporary.name)
    with NamedTemporaryFile(
        dir=target.parent, prefix=f".{target.stem}-cog-",
        suffix=".tif", delete=False,
    ) as cog_temporary:
        cog_path = Path(cog_temporary.name)
    try:
        with rasterio.open(source) as inputs:
            profile = inputs.profile.copy()
            profile.update(
                driver="GTiff",
                width=inputs.width * DERIVED_SCALE,
                height=inputs.height * DERIVED_SCALE,
                transform=inputs.transform * Affine.scale(
                    1 / DERIVED_SCALE, 1 / DERIVED_SCALE
                ),
                compress="DEFLATE",
                predictor=3,
                tiled=True,
                blockxsize=512,
                blockysize=512,
                BIGTIFF="IF_SAFER",
            )
            with rasterio.open(temporary_path, "w", **profile) as output:
                output.descriptions = inputs.descriptions
                for _, window in inputs.block_windows(1):
                    values = inputs.read(window=window)
                    expanded = np.repeat(
                        np.repeat(values, DERIVED_SCALE, axis=1),
                        DERIVED_SCALE, axis=2,
                    )
                    output.write(expanded, window=rasterio.windows.Window(
                        int(window.col_off) * DERIVED_SCALE,
                        int(window.row_off) * DERIVED_SCALE,
                        int(window.width) * DERIVED_SCALE,
                        int(window.height) * DERIVED_SCALE,
                    ))
                output.update_tags(
                    **inputs.tags(),
                    DERIVATION_ALGORITHM=DERIVED_INPUT_ALGORITHM,
                )
        copy_raster(
            temporary_path, cog_path, driver="COG", BLOCKSIZE=512,
            COMPRESS="DEFLATE", PREDICTOR="YES",
            OVERVIEW_RESAMPLING="NEAREST", BIGTIFF="IF_SAFER",
            NUM_THREADS="ALL_CPUS",
        )
        cog_path.chmod(0o644)
        os.replace(cog_path, target)
    finally:
        temporary_path.unlink(missing_ok=True)
        cog_path.unlink(missing_ok=True)
    return target


def write_product_manifest(
    target: Path,
    original_dem: Path,
    original_inputs: Path,
    derived_dem: Path,
    derived_inputs: Path,
    *,
    vertical_datum: str,
    object_uris: dict[Path, str] | None = None,
    additional_products: tuple[dict, ...] = (),
) -> Path:
    """Write the administrator registration manifest after asset creation."""
    paths = (original_dem, original_inputs, derived_dem, derived_inputs)
    if any(not path.is_file() for path in paths):
        raise FileNotFoundError("all DEM product assets must exist")
    with rasterio.open(original_dem) as original:
        crs = original.crs.to_string()
    object_uris = object_uris or {}
    additional_default_count = sum(
        bool(product.get("default", False))
        for product in additional_products
    )
    if additional_default_count > 1:
        raise ValueError("only one additional DEM product can be default")
    products = [
        _manifest_product(
            "bayuquan-dem-30m-v1", "鲅鱼圈原始 DEM · 30 m",
            original_dem, original_inputs, crs, vertical_datum,
            cell_size=30, source_resolution=30, method="original",
            max_cells=25_000, queue="standard", default=False,
            dem_uri=object_uris.get(original_dem),
            inputs_uri=object_uris.get(original_inputs),
        ),
        _manifest_product(
            "bayuquan-dem-10m-bilinear-v1", "鲅鱼圈插值 DEM · 10 m",
            derived_dem, derived_inputs, crs, vertical_datum,
            cell_size=10, source_resolution=30, method="bilinear",
            max_cells=125_000, queue="high-resource",
            default=additional_default_count == 0,
            dem_uri=object_uris.get(derived_dem),
            inputs_uri=object_uris.get(derived_inputs),
        ),
    ]
    for product in additional_products:
        dem = Path(product["dem"])
        inputs = Path(product["inputs"])
        if not dem.is_file() or not inputs.is_file():
            raise FileNotFoundError(
                f"DEM product assets must exist: {dem}, {inputs}"
            )
        products.append(_manifest_product(
            product["id"], product["name"], dem, inputs, crs,
            vertical_datum,
            cell_size=product["cell_size"],
            source_resolution=product.get(
                "source_resolution", product["cell_size"]
            ),
            method=product.get("method", "original"),
            max_cells=product["max_cells"],
            queue=product["queue"],
            default=product.get("default", False),
            dem_uri=object_uris.get(dem),
            inputs_uri=object_uris.get(inputs),
        ))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(
        {"products": products}, ensure_ascii=False, indent=2
    ) + "\n")
    return target


def _manifest_product(
    product_id, name, dem, inputs, crs, vertical_datum, *, cell_size,
    source_resolution, method, max_cells, queue, default,
    dem_uri=None, inputs_uri=None,
) -> dict:
    dem_hash = _sha256(dem)
    input_hash = _sha256(inputs)
    return {
        "id": product_id,
        "name": name,
        "status": "active",
        "isDefault": default,
        "datasetVersion": f"{product_id}-{dem_hash[:16]}-{input_hash[:16]}",
        "demUri": dem_uri or str(dem),
        "modelInputsUri": inputs_uri or str(inputs),
        "demSha256": dem_hash,
        "modelInputsSha256": input_hash,
        "crs": crs,
        "verticalDatum": vertical_datum,
        "elevationUnit": "m",
        "cellSizeM": cell_size,
        "sourceResolutionM": source_resolution,
        "resamplingMethod": method,
        "maxCells": max_cells,
        "resourceQueue": queue,
        "metadata": {
            "informationResolutionM": source_resolution,
            "derived": method != "original",
            "computeDemPath": str(dem),
            "computeModelInputsPath": str(inputs),
        },
    }


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def publish_product_assets(
    paths: tuple[Path, ...], *, endpoint_url: str, bucket: str,
    access_key: str, secret_key: str,
) -> dict[Path, str]:
    """Upload content-addressed product files to S3-compatible storage."""
    client = boto3.client(
        "s3", endpoint_url=endpoint_url,
        aws_access_key_id=access_key, aws_secret_access_key=secret_key,
    )
    try:
        client.head_bucket(Bucket=bucket)
    except Exception:
        client.create_bucket(Bucket=bucket)
    result = {}
    for path in paths:
        checksum = _sha256(path)
        key = f"dem-products/{checksum}/{path.name}"
        try:
            stored = client.head_object(Bucket=bucket, Key=key)
        except Exception:
            stored = None
        if not stored or stored.get("Metadata", {}).get("sha256") != checksum:
            client.upload_file(
                str(path), bucket, key,
                ExtraArgs={"Metadata": {"sha256": checksum}},
            )
        result[path] = f"s3://{bucket}/{key}"
    return result


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
    parser.add_argument("--derived-dem-target", type=Path)
    parser.add_argument("--derived-model-inputs-target", type=Path)
    parser.add_argument("--manifest-target", type=Path)
    parser.add_argument("--vertical-datum")
    parser.add_argument("--s3-endpoint-url")
    parser.add_argument("--s3-bucket")
    parser.add_argument("--s3-access-key")
    parser.add_argument("--s3-secret-key")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--additional-source", type=Path)
    parser.add_argument("--additional-dem-target", type=Path)
    parser.add_argument("--additional-model-inputs-target", type=Path)
    parser.add_argument("--additional-product-id")
    parser.add_argument("--additional-product-name")
    parser.add_argument("--additional-resolution", type=float)
    parser.add_argument("--additional-max-cells", type=int)
    parser.add_argument("--additional-resource-queue")
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
        derived_options = (
            args.derived_dem_target,
            args.derived_model_inputs_target,
            args.manifest_target,
            args.vertical_datum,
        )
        if any(derived_options) and not all(derived_options):
            parser.error(
                "derived targets, manifest target, and vertical datum "
                "must be provided together"
            )
        if all(derived_options):
            derived_dem = build_aligned_derived_dem(
                args.source, args.derived_dem_target, force=args.force
            )
            derived_inputs = build_aligned_derived_inputs(
                model_inputs, args.derived_model_inputs_target,
                force=args.force,
            )
            print(derived_dem)
            print(derived_inputs)
            additional_options = (
                args.additional_source,
                args.additional_dem_target,
                args.additional_model_inputs_target,
                args.additional_product_id,
                args.additional_product_name,
                args.additional_resolution,
                args.additional_max_cells,
                args.additional_resource_queue,
            )
            if any(additional_options) and not all(additional_options):
                parser.error(
                    "additional DEM source, targets, product metadata, and "
                    "resolution must be provided together"
                )
            additional_product = None
            additional_paths = ()
            if all(additional_options):
                with rasterio.open(result) as primary_dem:
                    target_crs = primary_dem.crs.to_string()
                additional_dem = build_reprojected_dem(
                    args.additional_source,
                    args.additional_dem_target,
                    target_crs=target_crs,
                    resolution_m=args.additional_resolution,
                    force=args.force,
                )
                additional_inputs = build_model_inputs_cog(
                    additional_dem,
                    args.buildings,
                    args.additional_model_inputs_target,
                    force=args.force,
                )
                print(additional_dem)
                print(additional_inputs)
                additional_product = {
                    "id": args.additional_product_id,
                    "name": args.additional_product_name,
                    "dem": additional_dem,
                    "inputs": additional_inputs,
                    "cell_size": args.additional_resolution,
                    "max_cells": args.additional_max_cells,
                    "queue": args.additional_resource_queue,
                    "default": True,
                }
                additional_paths = (additional_dem, additional_inputs)
            object_options = (
                args.s3_endpoint_url, args.s3_bucket,
                args.s3_access_key, args.s3_secret_key,
            )
            if any(object_options) and not all(object_options):
                parser.error("all S3 options must be provided together")
            object_uris = None
            if all(object_options):
                object_uris = publish_product_assets(
                    (result, model_inputs, derived_dem, derived_inputs)
                    + additional_paths,
                    endpoint_url=args.s3_endpoint_url,
                    bucket=args.s3_bucket,
                    access_key=args.s3_access_key,
                    secret_key=args.s3_secret_key,
                )
            print(write_product_manifest(
                args.manifest_target,
                result,
                model_inputs,
                derived_dem,
                derived_inputs,
                vertical_datum=args.vertical_datum,
                object_uris=object_uris,
                additional_products=(
                    (additional_product,) if additional_product else ()
                ),
            ))


if __name__ == "__main__":
    main()
