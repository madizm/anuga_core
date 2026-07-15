from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import rasterio
from rasterio.enums import MaskFlags

from bayuquan.raster import (
    CogWriter,
    FrameRasterizer,
    RasterGrid,
    build_interpolation_mapping,
)


class Quantity:
    def __init__(self, values):
        self.vertex_values = np.asarray(values, dtype=float)


def square_mapping():
    grid = RasterGrid(
        rows=1,
        columns=2,
        cellsize=1,
        xllcorner=0,
        yllcorner=0,
    )
    vertices = np.array([
        [[0, 0], [1, 0], [0, 1]],
        [[1, 0], [2, 0], [2, 1]],
    ], dtype=float)
    return build_interpolation_mapping(vertices, grid, "mesh-hash")


def frame(depth=2):
    mapping = square_mapping()
    vertices = np.array([
        [[0, 0], [1, 0], [0, 1]],
        [[1, 0], [2, 0], [2, 1]],
    ], dtype=float)
    elevation = vertices[:, :, 0]
    domain = SimpleNamespace(quantities={
        "elevation": Quantity(elevation),
        "stage": Quantity(elevation + depth),
        "xmomentum": Quantity(np.full((2, 3), 2 * depth)),
        "ymomentum": Quantity(np.zeros((2, 3))),
    })
    return FrameRasterizer(mapping).rasterize(domain, 300)


def test_rasterizer_interpolates_three_quantities_at_pixel_centres():
    result = frame()

    np.testing.assert_allclose(result.values[0], [[2, 2]])
    np.testing.assert_allclose(result.values[1], [[2.5, 3.5]])
    np.testing.assert_allclose(result.values[2], [[2, 2]])
    np.testing.assert_array_equal(result.display_mask, [[True, True]])
    assert result.maximum_depth_m == 2
    assert result.maximum_speed_mps == 2
    assert result.wet_area_m2 == 2


def test_cog_writer_publishes_aligned_three_band_cog(tmp_path):
    result = frame()
    target = tmp_path / "000000300.tif"

    written = CogWriter(square_mapping().grid).write(result, target)

    assert written.path == target
    assert written.size_bytes > 0
    assert not list(tmp_path.glob(".*.tif"))
    with rasterio.open(target) as dataset:
        assert dataset.driver == "GTiff"
        assert dataset.shape == (1, 2)
        assert dataset.count == 3
        assert dataset.crs.to_string() == "EPSG:32651"
        assert dataset.transform == rasterio.Affine(1, 0, 0, 0, -1, 1)
        assert dataset.descriptions == ("depth", "stage", "speed")
        assert dataset.units == ("m", "m", "m/s")
        assert dataset.nodata == -9999
        assert dataset.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
        np.testing.assert_allclose(dataset.read(), result.values)
        assert MaskFlags.per_dataset in dataset.mask_flag_enums[0]


def test_dry_pixels_keep_values_but_are_excluded_from_display_mask():
    result = frame(depth=0)

    np.testing.assert_allclose(result.values[0], [[0, 0]])
    np.testing.assert_allclose(result.values[1], [[0.5, 1.5]])
    np.testing.assert_array_equal(result.display_mask, [[False, False]])
    assert result.wet_area_m2 == 0
