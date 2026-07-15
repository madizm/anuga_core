"""Fixed-grid frame rasterization and COG output."""

from .cog_writer import CogWriter, WrittenCog
from .frame_rasterizer import FrameRasterizer, RasterFrame
from .local_frame_rasterizer import LocalFrameRasterizer
from .interpolation import (
    RasterGrid,
    RasterInterpolationMapping,
    RasterMappingError,
    build_interpolation_mapping,
)

__all__ = [
    "CogWriter",
    "FrameRasterizer",
    "LocalFrameRasterizer",
    "RasterFrame",
    "RasterGrid",
    "RasterInterpolationMapping",
    "RasterMappingError",
    "WrittenCog",
    "build_interpolation_mapping",
]
