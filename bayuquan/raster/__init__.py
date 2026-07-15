"""Fixed-grid frame rasterization and COG output."""

from .cog_writer import CogWriter, WrittenCog
from .frame_rasterizer import FrameRasterizer, RasterFrame
from .interpolation import (
    RasterGrid,
    RasterInterpolationMapping,
    RasterMappingError,
    build_interpolation_mapping,
)

__all__ = [
    "CogWriter",
    "FrameRasterizer",
    "RasterFrame",
    "RasterGrid",
    "RasterInterpolationMapping",
    "RasterMappingError",
    "WrittenCog",
    "build_interpolation_mapping",
]
