"""Geometry helpers used by Bayuquan fixed-model preprocessing."""

from __future__ import annotations

import json
from pathlib import Path

from pyproj import Transformer


CRS = "EPSG:32651"


def signed_area(polygon: list[list[float]]) -> float:
    return 0.5 * sum(
        x1 * y2 - x2 * y1
        for (x1, y1), (x2, y2) in zip(polygon, polygon[1:] + polygon[:1])
    )


def counter_clockwise(polygon: list[list[float]]) -> list[list[float]]:
    return polygon if signed_area(polygon) > 0 else list(reversed(polygon))


def load_projected_areas(path: Path):
    data = json.loads(path.read_text())
    transformer = Transformer.from_crs("OGC:CRS84", CRS, always_xy=True)
    areas = {}
    for feature in data["features"]:
        ring = feature["geometry"]["coordinates"][0][:-1]
        areas[feature["properties"]["type"]] = [
            list(transformer.transform(lon, lat)) for lon, lat in ring
        ]
    return areas
