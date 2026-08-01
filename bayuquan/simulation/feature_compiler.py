"""Compile workbench hydraulic features into ANUGA-ready geometry.

This module is the seam between the user-facing, CRS84 scenario model and the
projected mesh/quantity/operator details required by ANUGA.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import numpy as np
import rasterio
from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import transform as transform_geometry, unary_union

from .area import SimulationArea
from .hydraulic_features import (
    BreachSpec,
    EngineeringChannelSpec,
    HydraulicFeaturesSpec,
    LeveeSpec,
    SimpleChannelSpec,
)
from .spec import ScenarioValidationError


@dataclass(frozen=True)
class CompiledLevee:
    id: str
    name: str
    points_xyz: tuple[tuple[float, float, float], ...]
    q_factor: float
    minimum_freeboard_m: float


@dataclass(frozen=True)
class CompiledSimpleChannel:
    spec: SimpleChannelSpec
    polygon: Polygon


@dataclass(frozen=True)
class CompiledEngineeringChannel:
    spec: EngineeringChannelSpec
    centerline: LineString
    polygon: Polygon


@dataclass(frozen=True)
class CompiledFeatures:
    levees: tuple[CompiledLevee, ...]
    simple_channels: tuple[CompiledSimpleChannel, ...]
    engineering_channels: tuple[CompiledEngineeringChannel, ...]
    projected_structures: dict[str, tuple[tuple[float, float], ...]]
    projected_drainage_outlets: dict[str, tuple[float, float]]
    area_polygon: Polygon

    @property
    def breaklines(self) -> list[list[tuple[float, float]]]:
        lines = [
            [(x, y) for x, y, _ in levee.points_xyz]
            for levee in self.levees
        ]
        for channel in (*self.simple_channels, *self.engineering_channels):
            lines.append([
                (float(x), float(y))
                for x, y in channel.polygon.exterior.coords
            ])
        return lines


def compile_features(
    features: HydraulicFeaturesSpec,
    area: SimulationArea,
    dem_path: str,
) -> CompiledFeatures:
    """Project, spatially validate, and enrich all enabled features."""
    transformer = Transformer.from_crs(
        "OGC:CRS84", area.crs, always_xy=True
    )
    project = transformer.transform
    area_polygon = simulation_area_polygon(area)

    simple_channels = tuple(
        CompiledSimpleChannel(
            channel,
            transform_geometry(
                project, Polygon(channel.coordinates)
            ),
        )
        for channel in features.simple_channels
    )
    engineering_channels = tuple(
        _compile_engineering_channel(channel, project)
        for channel in features.engineering_channels
    )
    channel_polygons = [
        item.polygon for item in (*simple_channels, *engineering_channels)
    ]
    _validate_feature_coverage(
        area_polygon,
        [
            *(LineString(levee.coordinates) for levee in features.levees),
            *(item.polygon for item in simple_channels),
            *(item.centerline for item in engineering_channels),
        ],
        project,
    )
    for index, first in enumerate(channel_polygons):
        for second in channel_polygons[index + 1:]:
            if first.intersection(second).area > 1.0e-6:
                raise ScenarioValidationError(
                    "channel terrain-edit polygons must not overlap"
                )

    breaches_by_levee: dict[str, list[BreachSpec]] = {}
    for breach in features.breaches:
        breaches_by_levee.setdefault(breach.levee_id, []).append(breach)
    with rasterio.open(dem_path) as dem:
        levees = tuple(
            _compile_levee(
                levee,
                breaches_by_levee.get(levee.id, []),
                project,
                dem,
                area.cell_size_m,
            )
            for levee in features.levees
        )

    breakline_geometries = [
        LineString([(x, y) for x, y, _ in levee.points_xyz])
        for levee in levees
    ] + [polygon.boundary for polygon in channel_polygons]
    for index, first in enumerate(breakline_geometries):
        for second in breakline_geometries[index + 1:]:
            intersection = first.intersection(second)
            if not intersection.is_empty:
                raise ScenarioValidationError(
                    "levee and channel breaklines must not intersect; "
                    "split and connect them explicitly in a future revision"
                )

    projected_structures = {}
    for structure in (*features.culverts, *features.bridges):
        projected_structures[structure.id] = tuple(
            (float(x), float(y)) for x, y in map(
                lambda coordinate: project(*coordinate),
                structure.coordinates,
            )
        )
        line = LineString(projected_structures[structure.id])
        if not area_polygon.buffer(1.0e-6).covers(line):
            raise ScenarioValidationError(
                f"structure {structure.id} falls outside the simulation area"
            )
        if line.length < area.cell_size_m:
            raise ScenarioValidationError(
                f"structure {structure.id} must span at least one DEM cell"
            )

    projected_drainage_outlets = {}
    for outlet in features.drainage_outlets:
        x, y = project(*outlet.coordinate)
        point = (float(x), float(y))
        if not area_polygon.buffer(1.0e-6).covers(Point(point)):
            raise ScenarioValidationError(
                f"drainageOutlet {outlet.id} falls outside the simulation area"
            )
        projected_drainage_outlets[outlet.id] = point

    return CompiledFeatures(
        levees,
        simple_channels,
        engineering_channels,
        projected_structures,
        projected_drainage_outlets,
        area_polygon,
    )


def simulation_area_polygon(area: SimulationArea) -> Polygon:
    a, _, c, _, e, f = area.transform
    cells = [
        box(
            c + column * a,
            f + (row + 1) * e,
            c + (column + 1) * a,
            f + row * e,
        )
        for row, column in zip(area.cell_rows, area.cell_columns)
    ]
    merged = unary_union(cells)
    if not isinstance(merged, Polygon) or merged.interiors:
        raise ScenarioValidationError(
            "simulation area must compile to one polygon without holes"
        )
    return merged


def create_feature_domain(
    area: SimulationArea,
    compiled: CompiledFeatures,
):
    """Create a conforming triangular domain for feature-bearing scenarios."""
    import anuga
    boundary = [
        (float(x), float(y))
        for x, y in list(compiled.area_polygon.exterior.coords)[:-1]
    ]
    boundary_tags = {"open": list(range(len(boundary)))}
    region_points = []
    for channel in compiled.simple_channels:
        point = channel.polygon.representative_point()
        region_points.append((
            float(point.x), float(point.y), channel.spec.max_triangle_area_m2
        ))
    for channel in compiled.engineering_channels:
        point = channel.polygon.representative_point()
        region_points.append((
            float(point.x), float(point.y), channel.spec.max_triangle_area_m2
        ))
    return anuga.create_domain_from_regions(
        boundary,
        boundary_tags,
        maximum_triangle_area=area.cell_size_m ** 2 / 2.0,
        breaklines=compiled.breaklines or None,
        regionPtArea=region_points or None,
        mesh_geo_reference=anuga.Geo_reference(epsg=32651),
        use_cache=False,
        verbose=False,
    )


def triangle_cell_indices(domain, area: SimulationArea) -> np.ndarray:
    """Map arbitrary conforming triangles back to aligned output DEM cells."""
    coordinates = np.asarray(domain.centroid_coordinates, dtype=float)
    if not domain.geo_reference.is_absolute():
        coordinates = domain.geo_reference.get_absolute(coordinates)
    transform = rasterio.Affine(*area.transform)
    rows, columns = rasterio.transform.rowcol(
        transform, coordinates[:, 0], coordinates[:, 1]
    )
    result = np.asarray(rows, dtype=np.int64) * area.ncols + np.asarray(
        columns, dtype=np.int64
    )
    selected = set(area.cell_indices)
    if any(int(index) not in selected for index in result):
        raise RuntimeError(
            "generated mesh triangle falls outside simulation area")
    return result.astype(np.int32)


def apply_feature_quantities(
    domain,
    compiled: CompiledFeatures,
    dem_path: str,
    model_inputs_path: str,
    friction_scenario: str,
) -> None:
    """Sample source rasters and apply channel terrain/friction overrides."""
    vertex_coordinates = np.asarray(
        domain.get_vertex_coordinates(absolute=True), dtype=float
    ).reshape((-1, 3, 2))
    centroid_coordinates = np.asarray(
        domain.centroid_coordinates, dtype=float
    )
    if not domain.geo_reference.is_absolute():
        centroid_coordinates = domain.geo_reference.get_absolute(
            centroid_coordinates
        )
    flat_vertices = vertex_coordinates.reshape((-1, 2))
    with rasterio.open(dem_path) as dem:
        elevation = np.asarray([
            value[0] for value in dem.sample(flat_vertices)
        ], dtype=float).reshape((-1, 3))
    friction_band = {"low": 3, "middle": 4, "high": 5}[friction_scenario]
    with rasterio.open(model_inputs_path) as model_inputs:
        friction = np.asarray([
            value[0] for value in model_inputs.sample(
                centroid_coordinates, indexes=friction_band
            )
        ], dtype=float)

    for channel in compiled.simple_channels:
        vertex_mask = np.asarray([
            channel.polygon.covers(Point(x, y))
            for x, y in flat_vertices
        ]).reshape((-1, 3))
        if channel.spec.elevation_mode == "lowerBy":
            elevation[vertex_mask] -= float(channel.spec.depth_m)
        else:
            elevation[vertex_mask] = float(channel.spec.elevation_m)
        centroid_mask = np.asarray([
            channel.polygon.covers(Point(x, y))
            for x, y in centroid_coordinates
        ])
        friction[centroid_mask] = channel.spec.manning_n

    for channel in compiled.engineering_channels:
        for triangle_index, triangle in enumerate(vertex_coordinates):
            for vertex_index, coordinate in enumerate(triangle):
                point = Point(coordinate)
                if not channel.polygon.covers(point):
                    continue
                elevation[triangle_index, vertex_index] = min(
                    elevation[triangle_index, vertex_index],
                    _engineering_channel_elevation(channel, point),
                )
        centroid_mask = np.asarray([
            channel.polygon.covers(Point(x, y))
            for x, y in centroid_coordinates
        ])
        friction[centroid_mask] = channel.spec.manning_n

    if not np.all(np.isfinite(elevation)) or not np.all(np.isfinite(friction)):
        raise ValueError("compiled model quantities contain non-finite values")
    domain.set_quantity("elevation", elevation, location="vertices")
    domain.set_quantity("friction", friction, location="centroids")


def install_riverwalls(domain, compiled: CompiledFeatures) -> dict[str, object]:
    if not compiled.levees:
        return {}
    walls = {
        levee.id: [list(point) for point in levee.points_xyz]
        for levee in compiled.levees
    }
    parameters = {
        levee.id: {"Qfactor": levee.q_factor}
        for levee in compiled.levees
    }
    domain.create_riverwalls(walls, parameters, verbose=False)
    return {levee.id: levee for levee in compiled.levees}


def _compile_levee(
    levee: LeveeSpec,
    breaches: list[BreachSpec],
    project,
    dem,
    cell_size_m: float,
) -> CompiledLevee:
    line = transform_geometry(project, LineString(levee.coordinates))
    if line.length < cell_size_m:
        raise ScenarioValidationError(
            f"levee {levee.id} must be at least one DEM cell long"
        )
    base_chainages = _line_vertex_chainages(line)
    terrain = [float(value[0]) for value in dem.sample(line.coords)]
    if levee.crest_mode == "absolute":
        base_elevations = [float(levee.crest_elevation_m)] * len(line.coords)
    elif levee.crest_mode == "relative":
        base_elevations = [
            value + float(levee.height_above_ground_m) for value in terrain
        ]
    else:
        base_elevations = list(levee.crest_elevations_m)

    breach_ranges = []
    extra_chainages = []
    for breach in breaches:
        point = transform_geometry(project, Point(breach.coordinate))
        if line.distance(point) > max(1.0, cell_size_m * 0.25):
            raise ScenarioValidationError(
                f"breach {breach.id} is not located on levee {levee.id}"
            )
        center = line.project(point)
        start = max(0.0, center - breach.width_m / 2.0)
        end = min(line.length, center + breach.width_m / 2.0)
        if end <= start:
            raise ScenarioValidationError(
                f"breach {breach.id} has no effective width"
            )
        breach_ranges.append((start, end, breach.crest_elevation_m))
        extra_chainages.extend([start, end])
    chainages = sorted(set([*base_chainages, *extra_chainages]))
    points_xyz = []
    for chainage in chainages:
        point = line.interpolate(chainage)
        crest = float(np.interp(chainage, base_chainages, base_elevations))
        for start, end, breach_crest in breach_ranges:
            if start <= chainage <= end:
                crest = min(crest, breach_crest)
        points_xyz.append((float(point.x), float(point.y), crest))
    return CompiledLevee(
        levee.id,
        levee.name,
        tuple(points_xyz),
        levee.q_factor,
        min(
            crest - ground
            for crest, ground in zip(base_elevations, terrain)
        ),
    )


def _compile_engineering_channel(
    channel: EngineeringChannelSpec,
    project,
) -> CompiledEngineeringChannel:
    line = transform_geometry(project, LineString(channel.coordinates))
    if channel.cross_sections[-1].distance_m > line.length + 1.0e-6:
        raise ScenarioValidationError(
            f"engineeringChannel {channel.id} cross-sections exceed line length"
        )
    if channel.cross_sections[-1].distance_m < line.length * 0.95:
        raise ScenarioValidationError(
            f"engineeringChannel {channel.id} needs a section near its endpoint"
        )
    maximum_half_width = max(
        section.bottom_width_m / 2.0
        + section.side_slope * channel.bank_height_m
        for section in channel.cross_sections
    )
    polygon = line.buffer(
        maximum_half_width, cap_style="flat", join_style="round"
    )
    return CompiledEngineeringChannel(channel, line, polygon)


def _engineering_channel_elevation(
    channel: CompiledEngineeringChannel,
    point: Point,
) -> float:
    chainage = channel.centerline.project(point)
    sections = channel.spec.cross_sections
    distances = [section.distance_m for section in sections]
    bed = float(np.interp(
        chainage, distances, [section.bed_elevation_m for section in sections]
    ))
    width = float(np.interp(
        chainage, distances, [section.bottom_width_m for section in sections]
    ))
    slope = float(np.interp(
        chainage, distances, [section.side_slope for section in sections]
    ))
    offset = channel.centerline.distance(point)
    excess = max(0.0, offset - width / 2.0)
    if slope <= 0:
        return bed if excess <= 1.0e-6 else bed + channel.spec.bank_height_m
    return bed + min(channel.spec.bank_height_m, excess / slope)


def _validate_feature_coverage(
    area_polygon: Polygon,
    geometries: Iterable,
    project,
) -> None:
    for geometry in geometries:
        projected = (
            geometry if geometry.bounds[0] > 180
            else transform_geometry(project, geometry)
        )
        if not area_polygon.buffer(1.0e-6).covers(projected):
            raise ScenarioValidationError(
                "hydraulic feature geometry falls outside the simulation area"
            )


def _line_vertex_chainages(line: LineString) -> list[float]:
    coordinates = list(line.coords)
    chainages = [0.0]
    for previous, current in zip(coordinates, coordinates[1:]):
        chainages.append(
            chainages[-1] + Point(previous).distance(Point(current))
        )
    return chainages


def sample_elevation_profile(
    geometry: dict,
    area: SimulationArea,
    dem_path: str,
    *,
    spacing_m: float | None = None,
) -> dict:
    """Sample a CRS84 line against the selected DEM for workbench QC."""
    try:
        source_line = LineString(geometry["coordinates"])
    except (KeyError, TypeError, ValueError) as error:
        raise ScenarioValidationError(
            "profile geometry must be a LineString"
        ) from error
    if geometry.get("type") != "LineString" or not source_line.is_valid \
            or source_line.is_empty or len(source_line.coords) < 2:
        raise ScenarioValidationError(
            "profile geometry must be a valid LineString"
        )
    transformer = Transformer.from_crs(
        "OGC:CRS84", area.crs, always_xy=True
    )
    line = transform_geometry(transformer.transform, source_line)
    if not simulation_area_polygon(area).buffer(1.0e-6).covers(line):
        raise ScenarioValidationError(
            "profile line falls outside the simulation area"
        )
    spacing = spacing_m or max(1.0, area.cell_size_m / 2.0)
    sample_count = max(2, int(np.ceil(line.length / spacing)) + 1)
    distances = np.linspace(0.0, line.length, sample_count)
    points = [line.interpolate(float(distance)) for distance in distances]
    with rasterio.open(dem_path) as dem:
        elevations = [
            float(value[0])
            for value in dem.sample([(point.x, point.y) for point in points])
        ]
    return {
        "lengthM": float(line.length),
        "spacingM": float(spacing),
        "samples": [
            {
                "distanceM": float(distance),
                "elevationM": elevation,
                "longitude": float(source.x),
                "latitude": float(source.y),
            }
            for distance, elevation, source in zip(
                distances,
                elevations,
                [source_line.interpolate(index / (sample_count - 1), normalized=True)
                 for index in range(sample_count)],
            )
        ],
    }


def feature_mesh_preview(
    features: HydraulicFeaturesSpec,
    area: SimulationArea,
    dem_path: str,
    *,
    maximum_edges: int = 30_000,
) -> dict:
    """Generate an on-demand, decimated visual preview of the exact mesh."""
    compiled = compile_features(features, area, dem_path)
    domain = create_feature_domain(area, compiled)
    nodes = np.asarray(domain.get_nodes(absolute=True), dtype=float)
    triangles = np.asarray(domain.triangles, dtype=np.int64)
    unique_edges = sorted({
        tuple(sorted(edge))
        for triangle in triangles
        for edge in (
            (int(triangle[0]), int(triangle[1])),
            (int(triangle[1]), int(triangle[2])),
            (int(triangle[2]), int(triangle[0])),
        )
    })
    stride = max(1, int(np.ceil(len(unique_edges) / maximum_edges)))
    displayed_edges = unique_edges[::stride]
    to_wgs84 = Transformer.from_crs(
        area.crs, "OGC:CRS84", always_xy=True
    )
    coordinates = [
        [
            list(to_wgs84.transform(*nodes[first])),
            list(to_wgs84.transform(*nodes[second])),
        ]
        for first, second in displayed_edges
    ]
    return {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {
                "triangleCount": len(triangles),
                "edgeCount": len(unique_edges),
                "displayedEdgeCount": len(displayed_edges),
                "decimated": stride > 1,
            },
            "geometry": {
                "type": "MultiLineString",
                "coordinates": coordinates,
            },
        }],
        "triangleCount": len(triangles),
        "edgeCount": len(unique_edges),
        "displayedEdgeCount": len(displayed_edges),
        "decimated": stride > 1,
    }
