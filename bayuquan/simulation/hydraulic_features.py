"""Validated, immutable hydraulic feature specifications.

The workbench stores geometry in OGC:CRS84 longitude/latitude coordinates.
Runtime adapters project it to the selected DEM CRS before meshing or creating
ANUGA operators.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from shapely.geometry import LineString, Point, Polygon, shape

from .spec import ScenarioValidationError, _finite_number

Coordinate = tuple[float, float]
MAX_HYDRAULIC_FEATURES = 100
MAX_GEOMETRY_VERTICES = 2_000


def _id(data: dict[str, Any], feature_type: str) -> tuple[str, str]:
    feature_id = str(data.get("id", "")).strip()
    if not feature_id:
        raise ScenarioValidationError(f"{feature_type}.id is required")
    name = str(data.get("name", feature_id)).strip() or feature_id
    return feature_id, name


def _positive(data: dict[str, Any], key: str, field: str) -> float:
    value = _finite_number(data.get(key), field)
    if value <= 0:
        raise ScenarioValidationError(f"{field} must be greater than zero")
    return value


def _nonnegative(data: dict[str, Any], key: str, field: str) -> float:
    value = _finite_number(data.get(key), field)
    if value < 0:
        raise ScenarioValidationError(f"{field} must not be negative")
    return value


def _geometry(data: dict[str, Any], expected: type, field: str):
    raw = data.get("geometry")
    if not isinstance(raw, dict):
        raise ScenarioValidationError(f"{field}.geometry is required")
    raw_coordinates = raw.get("coordinates")
    vertex_count = (
        len(raw_coordinates[0])
        if expected is Polygon and isinstance(raw_coordinates, list)
        and raw_coordinates and isinstance(raw_coordinates[0], list)
        else len(raw_coordinates) if isinstance(raw_coordinates, list) else 0
    )
    if vertex_count > MAX_GEOMETRY_VERTICES:
        raise ScenarioValidationError(
            f"{field}.geometry exceeds {MAX_GEOMETRY_VERTICES} vertices"
        )
    try:
        result = shape(raw)
    except (TypeError, ValueError) as error:
        raise ScenarioValidationError(
            f"{field}.geometry is invalid") from error
    if not isinstance(result, expected) or result.is_empty or not result.is_valid:
        raise ScenarioValidationError(
            f"{field}.geometry must be a valid {expected.__name__}"
        )
    coordinates = (
        list(result.exterior.coords)
        if isinstance(result, Polygon)
        else list(result.coords)
    )
    for longitude, latitude, *_ in coordinates:
        if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
            raise ScenarioValidationError(
                f"{field}.geometry must use longitude/latitude coordinates"
            )
    return result


def _line_coordinates(line: LineString) -> tuple[Coordinate, ...]:
    return tuple((float(x), float(y)) for x, y, *_ in line.coords)


def _polygon_coordinates(polygon: Polygon) -> tuple[Coordinate, ...]:
    if polygon.interiors:
        raise ScenarioValidationError("channel polygons cannot contain holes")
    return tuple((float(x), float(y)) for x, y, *_ in polygon.exterior.coords)


@dataclass(frozen=True)
class LeveeSpec:
    id: str
    name: str
    coordinates: tuple[Coordinate, ...]
    crest_mode: Literal["absolute", "relative", "profile"]
    crest_elevation_m: float | None
    height_above_ground_m: float | None
    crest_elevations_m: tuple[float, ...]
    q_factor: float

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "LeveeSpec":
        feature_id, name = _id(data, "levee")
        field = f"levee {feature_id}"
        line = _geometry(data, LineString, field)
        if len(line.coords) < 2 or not line.is_simple:
            raise ScenarioValidationError(
                f"{field}.geometry must be a simple line"
            )
        mode = data.get("crestMode", "relative")
        if mode not in {"absolute", "relative", "profile"}:
            raise ScenarioValidationError(
                f"{field}.crestMode must be absolute, relative, or profile"
            )
        absolute = relative = None
        profile: tuple[float, ...] = ()
        if mode == "absolute":
            absolute = _finite_number(
                data.get("crestElevationM"), f"{field}.crestElevationM"
            )
        elif mode == "relative":
            relative = _positive(
                data, "heightAboveGroundM", f"{field}.heightAboveGroundM"
            )
        else:
            raw_profile = data.get("crestElevationsM")
            if not isinstance(raw_profile, list) or len(raw_profile) != len(line.coords):
                raise ScenarioValidationError(
                    f"{field}.crestElevationsM must match line vertices"
                )
            profile = tuple(
                _finite_number(value, f"{field}.crestElevationsM[{index}]")
                for index, value in enumerate(raw_profile)
            )
        q_factor = _positive(data, "qFactor", f"{field}.qFactor")
        return cls(
            feature_id, name, _line_coordinates(line), mode,
            absolute, relative, profile, q_factor,
        )


@dataclass(frozen=True)
class SimpleChannelSpec:
    id: str
    name: str
    coordinates: tuple[Coordinate, ...]
    elevation_mode: Literal["lowerBy", "absolute"]
    depth_m: float | None
    elevation_m: float | None
    manning_n: float
    max_triangle_area_m2: float

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SimpleChannelSpec":
        feature_id, name = _id(data, "simpleChannel")
        field = f"simpleChannel {feature_id}"
        polygon = _geometry(data, Polygon, field)
        mode = data.get("elevationMode", "lowerBy")
        if mode not in {"lowerBy", "absolute"}:
            raise ScenarioValidationError(
                f"{field}.elevationMode must be lowerBy or absolute"
            )
        depth = elevation = None
        if mode == "lowerBy":
            depth = _positive(data, "depthM", f"{field}.depthM")
        else:
            elevation = _finite_number(
                data.get("elevationM"), f"{field}.elevationM"
            )
        manning = _positive(data, "manningN", f"{field}.manningN")
        max_area = _positive(
            data, "maxTriangleAreaM2", f"{field}.maxTriangleAreaM2"
        )
        return cls(
            feature_id, name, _polygon_coordinates(polygon), mode,
            depth, elevation, manning, max_area,
        )


@dataclass(frozen=True)
class CrossSectionSpec:
    distance_m: float
    bed_elevation_m: float
    bottom_width_m: float
    side_slope: float

    @classmethod
    def from_dict(cls, data: Any, field: str) -> "CrossSectionSpec":
        if not isinstance(data, dict):
            raise ScenarioValidationError(f"{field} must be an object")
        return cls(
            _nonnegative(data, "distanceM", f"{field}.distanceM"),
            _finite_number(data.get("bedElevationM"),
                           f"{field}.bedElevationM"),
            _positive(data, "bottomWidthM", f"{field}.bottomWidthM"),
            _nonnegative(data, "sideSlope", f"{field}.sideSlope"),
        )


@dataclass(frozen=True)
class EngineeringChannelSpec:
    id: str
    name: str
    coordinates: tuple[Coordinate, ...]
    cross_sections: tuple[CrossSectionSpec, ...]
    bank_height_m: float
    manning_n: float
    max_triangle_area_m2: float

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EngineeringChannelSpec":
        feature_id, name = _id(data, "engineeringChannel")
        field = f"engineeringChannel {feature_id}"
        line = _geometry(data, LineString, field)
        if len(line.coords) < 2 or not line.is_simple:
            raise ScenarioValidationError(
                f"{field}.geometry must be a simple line"
            )
        raw_sections = data.get("crossSections")
        if not isinstance(raw_sections, list) or len(raw_sections) < 2:
            raise ScenarioValidationError(
                f"{field}.crossSections needs at least two sections"
            )
        sections = tuple(
            CrossSectionSpec.from_dict(item, f"{field}.crossSections[{index}]")
            for index, item in enumerate(raw_sections)
        )
        distances = [section.distance_m for section in sections]
        if distances[0] != 0 or any(
            current <= previous
            for previous, current in zip(distances, distances[1:])
        ):
            raise ScenarioValidationError(
                f"{field}.crossSections must start at 0 and strictly increase"
            )
        return cls(
            feature_id,
            name,
            _line_coordinates(line),
            sections,
            _positive(data, "bankHeightM", f"{field}.bankHeightM"),
            _positive(data, "manningN", f"{field}.manningN"),
            _positive(
                data, "maxTriangleAreaM2", f"{field}.maxTriangleAreaM2"
            ),
        )


@dataclass(frozen=True)
class CulvertSpec:
    id: str
    name: str
    coordinates: tuple[Coordinate, Coordinate]
    shape: Literal["box", "pipe"]
    width_m: float | None
    height_m: float | None
    diameter_m: float | None
    barrels: int
    blockage: float
    losses: float
    manning_n: float
    invert_elevations_m: tuple[float, float] | None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CulvertSpec":
        feature_id, name = _id(data, "culvert")
        field = f"culvert {feature_id}"
        line = _geometry(data, LineString, field)
        if len(line.coords) != 2:
            raise ScenarioValidationError(
                f"{field}.geometry must have exactly two endpoints"
            )
        shape_name = data.get("shape", "box")
        if shape_name not in {"box", "pipe"}:
            raise ScenarioValidationError(f"{field}.shape must be box or pipe")
        width = height = diameter = None
        if shape_name == "box":
            width = _positive(data, "widthM", f"{field}.widthM")
            height = _positive(data, "heightM", f"{field}.heightM")
        else:
            diameter = _positive(data, "diameterM", f"{field}.diameterM")
        raw_barrels = data.get("barrels", 1)
        if isinstance(raw_barrels, bool) or not isinstance(raw_barrels, int) or raw_barrels < 1:
            raise ScenarioValidationError(
                f"{field}.barrels must be a positive integer"
            )
        blockage = _nonnegative(data, "blockage", f"{field}.blockage")
        if blockage >= 1:
            raise ScenarioValidationError(
                f"{field}.blockage must be less than 1")
        raw_inverts = data.get("invertElevationsM")
        inverts = None
        if raw_inverts is not None:
            if not isinstance(raw_inverts, list) or len(raw_inverts) != 2:
                raise ScenarioValidationError(
                    f"{field}.invertElevationsM must contain two elevations"
                )
            inverts = tuple(
                _finite_number(value, f"{field}.invertElevationsM[{index}]")
                for index, value in enumerate(raw_inverts)
            )
        return cls(
            feature_id, name, _line_coordinates(line), shape_name,
            width, height, diameter, raw_barrels, blockage,
            _nonnegative(data, "losses", f"{field}.losses"),
            _positive(data, "manningN", f"{field}.manningN"),
            inverts,
        )


@dataclass(frozen=True)
class BridgeSpec:
    id: str
    name: str
    coordinates: tuple[Coordinate, Coordinate]
    width_m: float
    height_m: float
    left_side_slope: float
    right_side_slope: float
    blockage: float
    losses: float
    manning_n: float
    invert_elevations_m: tuple[float, float] | None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BridgeSpec":
        feature_id, name = _id(data, "bridge")
        field = f"bridge {feature_id}"
        line = _geometry(data, LineString, field)
        if len(line.coords) != 2:
            raise ScenarioValidationError(
                f"{field}.geometry must have exactly two endpoints"
            )
        blockage = _nonnegative(data, "blockage", f"{field}.blockage")
        if blockage >= 1:
            raise ScenarioValidationError(
                f"{field}.blockage must be less than 1")
        raw_inverts = data.get("invertElevationsM")
        inverts = None
        if raw_inverts is not None:
            if not isinstance(raw_inverts, list) or len(raw_inverts) != 2:
                raise ScenarioValidationError(
                    f"{field}.invertElevationsM must contain two elevations"
                )
            inverts = tuple(
                _finite_number(value, f"{field}.invertElevationsM[{index}]")
                for index, value in enumerate(raw_inverts)
            )
        return cls(
            feature_id, name, _line_coordinates(line),
            _positive(data, "widthM", f"{field}.widthM"),
            _positive(data, "heightM", f"{field}.heightM"),
            _nonnegative(data, "leftSideSlope", f"{field}.leftSideSlope"),
            _nonnegative(data, "rightSideSlope", f"{field}.rightSideSlope"),
            blockage,
            _nonnegative(data, "losses", f"{field}.losses"),
            _positive(data, "manningN", f"{field}.manningN"),
            inverts,
        )


@dataclass(frozen=True)
class BreachSpec:
    id: str
    name: str
    levee_id: str
    coordinate: Coordinate
    width_m: float
    crest_elevation_m: float

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BreachSpec":
        feature_id, name = _id(data, "breach")
        field = f"breach {feature_id}"
        point = _geometry(data, Point, field)
        levee_id = str(data.get("leveeId", "")).strip()
        if not levee_id:
            raise ScenarioValidationError(f"{field}.leveeId is required")
        return cls(
            feature_id,
            name,
            levee_id,
            (float(point.x), float(point.y)),
            _positive(data, "widthM", f"{field}.widthM"),
            _finite_number(
                data.get("crestElevationM"), f"{field}.crestElevationM"
            ),
        )


HydraulicFeatureSpec = (
    LeveeSpec | SimpleChannelSpec | EngineeringChannelSpec
    | CulvertSpec | BridgeSpec | BreachSpec
)


@dataclass(frozen=True)
class HydraulicFeaturesSpec:
    levees: tuple[LeveeSpec, ...]
    simple_channels: tuple[SimpleChannelSpec, ...]
    engineering_channels: tuple[EngineeringChannelSpec, ...]
    culverts: tuple[CulvertSpec, ...]
    bridges: tuple[BridgeSpec, ...]
    breaches: tuple[BreachSpec, ...]

    @property
    def all(self) -> tuple[HydraulicFeatureSpec, ...]:
        return (
            *self.levees,
            *self.simple_channels,
            *self.engineering_channels,
            *self.culverts,
            *self.bridges,
            *self.breaches,
        )

    @property
    def requires_custom_mesh(self) -> bool:
        return bool(self.levees or self.simple_channels or self.engineering_channels)

    @classmethod
    def from_list(cls, data: Any) -> "HydraulicFeaturesSpec":
        if data is None:
            data = []
        if not isinstance(data, list):
            raise ScenarioValidationError("hydraulicFeatures must be an array")
        if len(data) > MAX_HYDRAULIC_FEATURES:
            raise ScenarioValidationError(
                f"hydraulicFeatures cannot exceed {MAX_HYDRAULIC_FEATURES} items"
            )
        grouped: dict[str, list] = {
            "levee": [],
            "simpleChannel": [],
            "engineeringChannel": [],
            "culvert": [],
            "bridge": [],
            "breach": [],
        }
        parsers = {
            "levee": LeveeSpec.from_dict,
            "simpleChannel": SimpleChannelSpec.from_dict,
            "engineeringChannel": EngineeringChannelSpec.from_dict,
            "culvert": CulvertSpec.from_dict,
            "bridge": BridgeSpec.from_dict,
            "breach": BreachSpec.from_dict,
        }
        for index, item in enumerate(data):
            if not isinstance(item, dict):
                raise ScenarioValidationError(
                    f"hydraulicFeatures[{index}] must be an object"
                )
            if not item.get("enabled", True):
                continue
            feature_type = item.get("type")
            parser = parsers.get(feature_type)
            if parser is None:
                raise ScenarioValidationError(
                    f"hydraulicFeatures[{index}].type is unsupported"
                )
            grouped[feature_type].append(parser(item))
        features = cls(
            tuple(grouped["levee"]),
            tuple(grouped["simpleChannel"]),
            tuple(grouped["engineeringChannel"]),
            tuple(grouped["culvert"]),
            tuple(grouped["bridge"]),
            tuple(grouped["breach"]),
        )
        ids = [feature.id for feature in features.all]
        if len(ids) != len(set(ids)):
            raise ScenarioValidationError(
                "enabled hydraulic feature IDs must be unique"
            )
        levee_ids = {levee.id for levee in features.levees}
        for breach in features.breaches:
            if breach.levee_id not in levee_ids:
                raise ScenarioValidationError(
                    f"breach {breach.id} references unknown levee {breach.levee_id}"
                )
        return features
