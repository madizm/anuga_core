"""Atomic writer and validator for Bayuquan five-band frame COGs."""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from affine import Affine
from rasterio.shutil import copy as raster_copy

from .frame_rasterizer import FrameRasterizer, RasterFrame
from .interpolation import RasterGrid


NODATA = -9999.0


@dataclass(frozen=True)
class WrittenCog:
    path: Path
    size_bytes: int


class CogWriter:
    """Write a frame completely and validate it before atomic publication."""

    def __init__(self, grid: RasterGrid, *, compression: str = "DEFLATE"):
        self.grid = grid
        self.compression = compression.upper()
        if self.compression not in {"DEFLATE", "ZSTD"}:
            raise ValueError("COG compression must be DEFLATE or ZSTD")

    def write(self, frame: RasterFrame, destination: Path | str) -> WrittenCog:
        target = Path(destination)
        target.parent.mkdir(parents=True, exist_ok=True)
        expected_shape = (5, self.grid.rows, self.grid.columns)
        if frame.values.shape != expected_shape:
            raise ValueError(
                f"frame shape {frame.values.shape} does not match "
                f"{expected_shape}"
            )
        if frame.display_mask.shape != expected_shape[1:]:
            raise ValueError("frame display mask does not match output grid")

        stage_path = self._temporary_path(target.parent, ".stage.tif")
        cog_path = self._temporary_path(target.parent, ".cog.tif")
        try:
            self._write_staging(frame, stage_path)
            raster_copy(
                stage_path,
                cog_path,
                driver="COG",
                compress=self.compression,
                blocksize=256,
                overviews="NONE",
            )
            self.validate(cog_path)
            os.replace(cog_path, target)
        finally:
            stage_path.unlink(missing_ok=True)
            cog_path.unlink(missing_ok=True)
        return WrittenCog(path=target, size_bytes=target.stat().st_size)

    def _write_staging(self, frame: RasterFrame, path: Path) -> None:
        data = np.asarray(frame.values, dtype=np.float32).copy()
        model_mask = np.isfinite(data).all(axis=0)
        data[:, ~model_mask] = NODATA
        profile = {
            "driver": "GTiff",
            "width": self.grid.columns,
            "height": self.grid.rows,
            "count": 5,
            "dtype": "float32",
            "crs": self.grid.crs,
            "transform": Affine(*self.grid.transform_tuple),
            "nodata": NODATA,
            "tiled": True,
            "blockxsize": 256,
            "blockysize": 256,
            "compress": self.compression,
        }
        with rasterio.open(path, "w", **profile) as dataset:
            dataset.write(data)
            dataset.write_mask(frame.display_mask.astype(np.uint8) * 255)
            dataset.descriptions = FrameRasterizer.band_names
            dataset.units = FrameRasterizer.band_units
            dataset.update_tags(
                time_seconds=f"{frame.time_seconds:g}",
                maximum_depth_m=f"{frame.maximum_depth_m:.9g}",
                maximum_speed_mps=f"{frame.maximum_speed_mps:.9g}",
                wet_area_m2=f"{frame.wet_area_m2:.9g}",
            )

    def validate(self, path: Path | str) -> None:
        with rasterio.open(path) as dataset:
            if dataset.shape != (self.grid.rows, self.grid.columns):
                raise ValueError("COG dimensions do not match fixed grid")
            if dataset.count != 5:
                raise ValueError("COG must contain exactly five bands")
            if dataset.crs is None or dataset.crs.to_string() != self.grid.crs:
                raise ValueError("COG CRS does not match fixed grid")
            expected_transform = Affine(*self.grid.transform_tuple)
            if dataset.transform != expected_transform:
                raise ValueError("COG transform does not match fixed grid")
            if dataset.dtypes != ("float32",) * 5:
                raise ValueError("COG bands must be Float32")
            if dataset.nodata != NODATA:
                raise ValueError("COG NoData value is invalid")
            if dataset.descriptions != FrameRasterizer.band_names:
                raise ValueError("COG band order is invalid")
            if dataset.units != FrameRasterizer.band_units:
                raise ValueError("COG band units are invalid")
            layout = dataset.tags(ns="IMAGE_STRUCTURE").get("LAYOUT")
            if layout != "COG":
                raise ValueError("output is not a cloud-optimized GeoTIFF")
            values = dataset.read()
            model_mask = np.isfinite(values).all(axis=0) & np.all(
                values != NODATA, axis=0
            )
            if np.any(values[0, model_mask] < 0):
                raise ValueError("COG contains negative water depth")

    @staticmethod
    def _temporary_path(directory: Path, suffix: str) -> Path:
        descriptor, name = tempfile.mkstemp(dir=directory, suffix=suffix)
        os.close(descriptor)
        path = Path(name)
        path.unlink()
        return path
