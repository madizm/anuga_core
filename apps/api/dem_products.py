"""Database-backed immutable DEM product catalog."""

from __future__ import annotations

import json
import hashlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from sqlalchemy import select, text

from bayuquan.simulation.area_catalog import SimulationAreaCatalog

from .db import Database
from .models import DemProduct


class DemProductError(ValueError):
    """Raised when a product is missing, unavailable, or inconsistent."""


@dataclass(frozen=True)
class DemProductView:
    id: str
    name: str
    status: str
    is_default: bool
    dataset_version: str
    dem_uri: str
    model_inputs_uri: str
    dem_sha256: str
    model_inputs_sha256: str
    crs: str
    vertical_datum: str
    elevation_unit: str
    cell_size_m: float
    source_resolution_m: float
    resampling_method: str
    max_cells: int
    resource_queue: str
    metadata: dict

    @classmethod
    def from_model(cls, product: DemProduct) -> "DemProductView":
        return cls(
            id=product.id,
            name=product.name,
            status=product.status,
            is_default=product.is_default,
            dataset_version=product.dataset_version,
            dem_uri=product.dem_uri,
            model_inputs_uri=product.model_inputs_uri,
            dem_sha256=product.dem_sha256,
            model_inputs_sha256=product.model_inputs_sha256,
            crs=product.crs,
            vertical_datum=product.vertical_datum,
            elevation_unit=product.elevation_unit,
            cell_size_m=product.cell_size_m,
            source_resolution_m=product.source_resolution_m,
            resampling_method=product.resampling_method,
            max_cells=product.max_cells,
            resource_queue=product.resource_queue,
            metadata=dict(product.metadata_json or {}),
        )

    @property
    def compute_dem_uri(self) -> str:
        return self.metadata.get("computeDemPath", self.dem_uri)

    @property
    def compute_model_inputs_uri(self) -> str:
        return self.metadata.get(
            "computeModelInputsPath", self.model_inputs_uri
        )

    def response(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "status": self.status,
            "isDefault": self.is_default,
            "datasetVersion": self.dataset_version,
            "crs": self.crs,
            "verticalDatum": self.vertical_datum,
            "elevationUnit": self.elevation_unit,
            "cellSizeM": self.cell_size_m,
            "sourceResolutionM": self.source_resolution_m,
            "resamplingMethod": self.resampling_method,
            "maxCells": self.max_cells,
            "maxTriangles": self.max_cells * 2,
            "resourceQueue": self.resource_queue,
            "demSha256": self.dem_sha256,
            "demTilejsonUrl": f"/api/dem-products/{self.id}/tilejson",
            "terrainTilejsonUrl": f"/api/dem-products/{self.id}/terrain/tilejson",
            "simulationAreaResolveUrl": (
                f"/api/dem-products/{self.id}/simulation-areas/resolve"
            ),
            "informationResolutionM": self.metadata.get(
                "informationResolutionM", self.source_resolution_m
            ),
            "derived": self.metadata.get(
                "derived", self.resampling_method != "original"
            ),
            "metadata": self.metadata,
        }


class DemProductCatalog:
    """Resolve product metadata and lazily construct product area catalogs."""

    def __init__(self, database: Database, cache_directory: Path | str):
        self.database = database
        self.cache_directory = Path(cache_directory)
        self._area_catalogs: dict[tuple[str, str], SimulationAreaCatalog] = {}

    def list(self, *, include_unavailable: bool = False) -> list[DemProductView]:
        with self.database.session_factory() as session:
            statement = select(DemProduct).order_by(
                DemProduct.is_default.desc(), DemProduct.cell_size_m
            )
            products = session.scalars(statement).all()
        views = [DemProductView.from_model(item) for item in products]
        if not include_unavailable:
            views = [item for item in views if item.status != "unavailable"]
        return views

    def get(self, product_id: str, *, for_new_area: bool = False) -> DemProductView:
        with self.database.session_factory() as session:
            product = session.get(DemProduct, product_id)
            if product is None:
                raise KeyError(product_id)
            view = DemProductView.from_model(product)
        if view.status == "unavailable":
            raise DemProductError(f"DEM product is unavailable: {product_id}")
        if for_new_area and view.status != "active":
            raise DemProductError(f"DEM product is not active: {product_id}")
        return view

    def default(self) -> DemProductView:
        active_defaults = [
            item for item in self.list() if item.status == "active" and item.is_default
        ]
        if len(active_defaults) != 1:
            raise DemProductError(
                "exactly one active DEM product must be configured as default"
            )
        return active_defaults[0]

    def area_catalog(
        self, product_id: str, *, for_new_area: bool = False
    ) -> SimulationAreaCatalog:
        product = self.get(product_id, for_new_area=for_new_area)
        key = (product.id, product.dataset_version)
        catalog = self._area_catalogs.get(key)
        if catalog is None:
            catalog = SimulationAreaCatalog(
                product.compute_dem_uri,
                self.cache_directory / product.id,
                dataset_version=product.dataset_version,
                model_inputs_path=product.compute_model_inputs_uri,
                max_cells=product.max_cells,
            )
            self._area_catalogs[key] = catalog
        return catalog


def register_manifest(database: Database, manifest_path: Path | str) -> None:
    """Register validated immutable products from an administrator manifest."""
    path = Path(manifest_path)
    if not path.is_file():
        raise FileNotFoundError(f"DEM product manifest not found: {path}")
    document = json.loads(path.read_text())
    products = document.get("products")
    if not isinstance(products, list) or not products:
        raise DemProductError("DEM product manifest has no products")
    defaults = [item for item in products if item.get("isDefault")]
    if len(defaults) != 1 or defaults[0].get("status", "active") != "active":
        raise DemProductError(
            "manifest needs exactly one active default product")

    validated = [_validate_manifest_product(item) for item in products]
    _validate_product_set(validated)
    with database.session_factory.begin() as session:
        if session.bind is not None \
                and session.bind.dialect.name == "postgresql":
            session.execute(text(
                "SELECT pg_advisory_xact_lock(191220240731)"
            ))
        for values in validated:
            existing = session.get(DemProduct, values["id"])
            if existing is None:
                session.add(DemProduct(**values))
                continue
            immutable = (
                "dataset_version", "dem_uri", "model_inputs_uri",
                "dem_sha256", "model_inputs_sha256", "crs", "vertical_datum",
                "elevation_unit", "cell_size_m", "source_resolution_m",
                "resampling_method", "max_cells", "resource_queue",
            )
            if any(getattr(existing, field) != values[field] for field in immutable):
                raise DemProductError(
                    f"immutable DEM product changed; use a new id: {existing.id}"
                )
            existing.name = values["name"]
            existing.status = values["status"]
            existing.is_default = values["is_default"]
            existing.metadata_json = values["metadata_json"]


def _validate_manifest_product(item: dict) -> dict:
    aliases = {
        "is_default": "isDefault",
        "dataset_version": "datasetVersion",
        "dem_uri": "demUri",
        "model_inputs_uri": "modelInputsUri",
        "dem_sha256": "demSha256",
        "model_inputs_sha256": "modelInputsSha256",
        "vertical_datum": "verticalDatum",
        "elevation_unit": "elevationUnit",
        "cell_size_m": "cellSizeM",
        "source_resolution_m": "sourceResolutionM",
        "resampling_method": "resamplingMethod",
        "max_cells": "maxCells",
        "resource_queue": "resourceQueue",
        "metadata_json": "metadata",
    }
    required = (
        "id", "name", "dataset_version", "dem_uri", "model_inputs_uri",
        "dem_sha256", "model_inputs_sha256", "crs", "vertical_datum",
        "cell_size_m", "source_resolution_m", "resampling_method",
        "max_cells", "resource_queue",
    )
    values = {
        field: item.get(aliases.get(field, field))
        for field in required
    }
    missing = [field for field, value in values.items() if value in (None, "")]
    if missing:
        raise DemProductError(
            f"DEM product is missing {', '.join(missing)}: {item.get('id')}"
        )
    values.update({
        "status": item.get("status", "active"),
        "is_default": bool(item.get("isDefault", False)),
        "elevation_unit": item.get("elevationUnit", "m"),
        "metadata_json": item.get("metadata", {}),
    })
    if values["status"] not in {"active", "deprecated", "unavailable"}:
        raise DemProductError("invalid DEM product status")
    if int(values["max_cells"]) <= 0:
        raise DemProductError("DEM product maxCells must be positive")
    _validate_aligned_bundle(values)
    return values


def _validate_aligned_bundle(values: dict) -> None:
    """Validate alignment once at registration; checksums come from the builder."""
    metadata = values["metadata_json"]
    dem_path = metadata.get("computeDemPath", values["dem_uri"])
    inputs_path = metadata.get(
        "computeModelInputsPath", values["model_inputs_uri"]
    )
    with rasterio.open(dem_path) as dem, rasterio.open(
        inputs_path
    ) as model_inputs:
        if dem.crs is None or dem.crs.to_string() != values["crs"]:
            raise DemProductError("DEM CRS does not match product metadata")
        if dem.shape != model_inputs.shape or dem.crs != model_inputs.crs:
            raise DemProductError("model inputs are not aligned with DEM")
        if not np.allclose(tuple(dem.transform), tuple(model_inputs.transform)):
            raise DemProductError("model inputs transform does not match DEM")
        if not np.isclose(abs(dem.transform.a), values["cell_size_m"]):
            raise DemProductError(
                "DEM cell size does not match product metadata")
        if model_inputs.descriptions != (
            "building_fraction", "building_density_class", "manning_low",
            "manning_middle", "manning_high",
        ):
            raise DemProductError("model inputs have unexpected bands")
    for field, uri_field in (
        ("dem_sha256", "dem_uri"),
        ("model_inputs_sha256", "model_inputs_uri"),
    ):
        uri = values[uri_field]
        if uri.startswith("s3://"):
            if values[field] not in uri:
                raise DemProductError(
                    f"{field} is not part of the immutable object key"
                )
        else:
            actual = _sha256(Path(uri))
            if values[field] != actual:
                raise DemProductError(
                    f"{field} does not match registered file"
                )


def _validate_product_set(products: list[dict]) -> None:
    standards = {
        (item["crs"], item["vertical_datum"], item["elevation_unit"])
        for item in products
    }
    if len(standards) != 1:
        raise DemProductError(
            "all DEM products must use one CRS, vertical datum, and unit"
        )
    originals = [
        item for item in products if item["resampling_method"] == "original"
    ]
    for derived in (
        item for item in products if item["resampling_method"] != "original"
    ):
        sources = [
            item for item in originals
            if np.isclose(
                item["cell_size_m"], derived["source_resolution_m"]
            )
        ]
        if len(sources) != 1:
            raise DemProductError(
                f"derived product needs one source grid: {derived['id']}"
            )
        source_path = sources[0]["metadata_json"].get(
            "computeDemPath", sources[0]["dem_uri"]
        )
        derived_path = derived["metadata_json"].get(
            "computeDemPath", derived["dem_uri"]
        )
        with rasterio.open(source_path) as source, rasterio.open(
            derived_path
        ) as target:
            ratio = source.transform.a / target.transform.a
            scale = round(ratio)
            if (
                not np.isclose(ratio, scale)
                or target.width != source.width * scale
                or target.height != source.height * scale
                or not np.isclose(target.transform.c, source.transform.c)
                or not np.isclose(target.transform.f, source.transform.f)
            ):
                raise DemProductError(
                    f"derived product grid is not strictly nested: {derived['id']}"
                )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()
