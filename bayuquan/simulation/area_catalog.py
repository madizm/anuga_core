"""Persistent compact storage for resolved local simulation areas."""

from __future__ import annotations

import json
import os
import shutil
import struct
import tempfile
from pathlib import Path
from typing import Mapping

import numpy as np
import rasterio
from pyproj import Transformer

from .area import SimulationArea, SimulationAreaResolver, build_local_mesh
from .grid_mapping import GridTriangleMapping


class SimulationAreaCatalog:
    """Resolve areas and atomically cache their grid and mesh artifacts."""

    def __init__(
        self,
        dem_path: Path | str,
        cache_directory: Path | str,
        *,
        dataset_version: str,
        model_inputs_path: Path | str | None = None,
        max_cells: int = 25_000,
    ) -> None:
        self.dem_path = str(dem_path)
        self.cache_directory = Path(cache_directory)
        self.model_inputs_path = (
            None if model_inputs_path is None else str(model_inputs_path)
        )
        self.resolver = SimulationAreaResolver(
            self.dem_path,
            dataset_version=dataset_version,
            max_cells=max_cells,
        )

    def metadata(self) -> dict:
        with rasterio.open(self.dem_path) as dem:
            return {
                "version": self.resolver.dataset_version[:8],
                "datasetVersion": self.resolver.dataset_version,
                "crs": dem.crs.to_string(),
                "gridRows": dem.height,
                "gridColumns": dem.width,
                "cellSizeM": abs(dem.transform.a),
                "simulationAreaResolveUrl": (
                    "/api/model/simulation-areas/resolve"
                ),
                "demTilejsonUrl": "/api/model/dem/tilejson",
                "boundaryCondition": "transmissive",
                "maxSimulationAreaCells": self.resolver.max_cells,
            }

    def resolve(
        self,
        geometry: Mapping,
        *,
        geometry_crs: str = "EPSG:4326",
    ) -> SimulationArea:
        area = self.resolver.resolve(geometry, geometry_crs=geometry_crs)
        target = self.cache_directory / area.area_hash
        if not target.exists():
            self._cache(area, target)
        return area

    def area(self, area_hash: str) -> SimulationArea:
        metadata = self._read_json(area_hash, "area.json")
        arrays = self._grid_arrays(area_hash)
        cell_indices = tuple(
            int(index) for index in arrays["cell_indices"]
        )
        ncols = metadata["demColumns"]
        if len(cell_indices) != metadata["cellCount"]:
            raise KeyError(f"corrupt simulation area: {area_hash}")
        cell_rows = tuple(index // ncols for index in cell_indices)
        cell_columns = tuple(index % ncols for index in cell_indices)
        area = SimulationArea(
            area_hash=metadata["areaHash"],
            dataset_version=metadata["datasetVersion"],
            crs=metadata["crs"],
            cell_ids=tuple(
                f"r{row:04d}-c{column:04d}"
                for row, column in zip(cell_rows, cell_columns)
            ),
            cell_indices=cell_indices,
            cell_rows=cell_rows,
            cell_columns=cell_columns,
            nrows=metadata["demRows"],
            ncols=metadata["demColumns"],
            transform=tuple(metadata["transform"]),
            window=tuple(metadata["window"]),
            cell_size_m=metadata["cellSizeM"],
            elevation_m=metadata["elevationM"],
        )
        if area.dataset_version != self.resolver.dataset_version:
            raise KeyError(f"stale simulation area: {area_hash}")
        return area

    def snapshot(self, area_hash: str) -> dict:
        metadata = self._read_json(area_hash, "area.json")
        if metadata["datasetVersion"] != self.resolver.dataset_version:
            raise KeyError(f"stale simulation area: {area_hash}")
        return metadata

    def grid_binary(self, area_hash: str) -> bytes:
        """Return the compact BQSG v1 browser payload for an area grid."""
        area = self.area(area_hash)
        arrays = self._grid_arrays(area_hash)
        row_start, row_stop, column_start, column_stop = area.window
        a, _, c, _, e, f = area.transform
        projected_corners = (
            (c + column_start * a, f + row_start * e),
            (c + column_stop * a, f + row_start * e),
            (c + column_start * a, f + row_stop * e),
            (c + column_stop * a, f + row_stop * e),
        )
        to_wgs84 = Transformer.from_crs(
            area.crs, "OGC:CRS84", always_xy=True
        )
        corners = tuple(
            coordinate
            for point in projected_corners
            for coordinate in to_wgs84.transform(*point)
        )
        header = struct.pack(
            "<4sHH7I8d",
            b"BQSG", 1, 100, area.cell_count, area.nrows, area.ncols,
            row_start, row_stop, column_start, column_stop, *corners,
        )
        planes = (
            np.asarray(arrays["cell_indices"], dtype="<u4"),
            np.asarray(arrays["elevation_m"], dtype="<f4"),
            np.asarray(arrays["building_fraction"], dtype="<f4"),
            np.asarray(arrays["building_density_class"], dtype="<f4"),
            np.asarray(arrays["manning_low"], dtype="<f4"),
            np.asarray(arrays["manning_middle"], dtype="<f4"),
            np.asarray(arrays["manning_high"], dtype="<f4"),
        )
        return header + b"".join(plane.tobytes() for plane in planes)

    def _grid_arrays(self, area_hash: str) -> dict[str, np.ndarray]:
        path = self.cache_directory / area_hash / "grid.npz"
        if not path.is_file():
            raise KeyError(f"unknown simulation area: {area_hash}")
        with np.load(path, allow_pickle=False) as data:
            return {name: data[name].copy() for name in data.files}

    def mesh_path(self, area_hash: str) -> Path:
        path = self.cache_directory / area_hash / "mesh.npz"
        if not path.is_file():
            raise KeyError(f"unknown simulation area: {area_hash}")
        return path

    def mapping(self, area_hash: str) -> GridTriangleMapping:
        area = self.area(area_hash)
        with np.load(self.mesh_path(area_hash), allow_pickle=False) as mesh:
            triangle_cells = mesh["triangle_cell_index"]
        return GridTriangleMapping(
            triangle_cell_index=triangle_cells,
            triangle_area_m2=np.full(
                len(triangle_cells), area.cell_size_m ** 2 / 2.0
            ),
            nrows=area.nrows,
            ncols=area.ncols,
            cellsize=area.cell_size_m,
            xllcorner=area.transform[2],
            yllcorner=(
                area.transform[5] + area.nrows * area.transform[4]
            ),
            mesh_sha256=area.area_hash,
        )

    def cell_values(
        self, area_hash: str, cell_ids: list[str], field: str
    ) -> list[float]:
        """Read one compact grid field for validated cell IDs."""
        mapping = self.mapping(area_hash)
        indices = np.asarray([
            mapping.parse_cell_id(cell_id)[2] for cell_id in cell_ids
        ], dtype=np.uint32)
        return self._values_for_indices(area_hash, indices, (field,))[field]

    def _values_for_indices(
        self,
        area_hash: str,
        selected_indices: np.ndarray,
        fields: tuple[str, ...],
    ) -> dict[str, list[float]]:
        arrays = self._grid_arrays(area_hash)
        missing = set(fields).difference(arrays)
        if missing:
            raise KeyError(f"unknown grid field: {sorted(missing)[0]}")
        positions = np.searchsorted(arrays["cell_indices"], selected_indices)
        return {
            field: [float(value) for value in arrays[field][positions]]
            for field in fields
        }

    def resolve_selection(
        self,
        area_hash: str,
        cell_ids: list[str],
        friction_scenario: str,
    ) -> dict:
        mapping = self.mapping(area_hash)
        selection = mapping.resolve(cell_ids)
        indices = np.asarray([
            mapping.parse_cell_id(cell_id)[2]
            for cell_id in selection.cell_ids
        ], dtype=np.uint32)
        manning_field = f"manning_{friction_scenario}"
        values = self._values_for_indices(
            area_hash, indices,
            ("elevation_m", "building_fraction", manning_field),
        )
        elevations = _finite_values(np.asarray(values["elevation_m"]))
        buildings = _finite_values(np.asarray(values["building_fraction"]))
        manning = _finite_values(np.asarray(values[manning_field]))
        result = {
            "cellIds": list(selection.cell_ids),
            "cellCount": len(selection.cell_ids),
            "geometricAreaM2": selection.geometric_area_m2,
            "triangleCount": len(selection.triangle_ids),
            "effectiveTriangleAreaM2": selection.effective_triangle_area_m2,
        }
        if elevations:
            result["elevationM"] = _summary(elevations, include_mean=True)
        if buildings:
            result["buildingFraction"] = _summary(buildings)
        if manning:
            result["manning"] = _summary(manning)
        return result

    def _read_json(self, area_hash: str, filename: str) -> dict:
        if len(area_hash) != 64 or any(
            character not in "0123456789abcdef" for character in area_hash
        ):
            raise KeyError(f"unknown simulation area: {area_hash}")
        path = self.cache_directory / area_hash / filename
        if not path.is_file():
            raise KeyError(f"unknown simulation area: {area_hash}")
        return json.loads(path.read_text())

    def _cache(self, area: SimulationArea, target: Path) -> None:
        self.cache_directory.mkdir(parents=True, exist_ok=True)
        temporary = Path(tempfile.mkdtemp(
            prefix=f".{area.area_hash}.", dir=self.cache_directory
        ))
        try:
            metadata = {
                "areaHash": area.area_hash,
                "datasetVersion": area.dataset_version,
                "crs": area.crs,
                "cellCount": area.cell_count,
                "areaM2": area.area_m2,
                "demRows": area.nrows,
                "demColumns": area.ncols,
                "transform": area.transform,
                "window": area.window,
                "cellSizeM": area.cell_size_m,
                "elevationM": area.elevation_m,
                "meshRule": "square-sw-ne-v1",
                "triangleCount": area.cell_count * 2,
                "boundaryCondition": "transmissive",
            }
            _write_json(temporary / "area.json", metadata)
            np.savez_compressed(
                temporary / "grid.npz",
                **_grid_arrays(area, self.dem_path, self.model_inputs_path),
            )

            mesh = build_local_mesh(area)
            boundary_items = sorted(mesh.boundary)
            np.savez_compressed(
                temporary / "mesh.npz",
                coordinates=mesh.coordinates,
                triangles=mesh.triangles,
                boundary_triangle=np.asarray(
                    [item[0] for item in boundary_items], dtype=np.int32
                ),
                boundary_edge=np.asarray(
                    [item[1] for item in boundary_items], dtype=np.int8
                ),
                triangle_cell_index=mesh.triangle_cell_index,
                origin=np.asarray(mesh.origin, dtype=float),
                crs=np.array(mesh.crs),
                area_hash=np.array(area.area_hash),
            )
            try:
                os.replace(temporary, target)
            except OSError:
                if not target.is_dir():
                    raise
                shutil.rmtree(temporary)
        except BaseException:
            if temporary.exists():
                shutil.rmtree(temporary)
            raise


def _grid_arrays(
    area: SimulationArea,
    dem_path: Path | str,
    model_inputs_path: Path | str | None = None,
) -> dict[str, np.ndarray]:
    return {
        "cell_indices": np.asarray(area.cell_indices, dtype=np.uint32),
        **_model_input_arrays(area, dem_path, model_inputs_path),
    }


def _model_input_arrays(
    area: SimulationArea,
    dem_path: Path | str,
    path: Path | str | None,
) -> dict[str, np.ndarray]:
    row_start, row_stop, column_start, column_stop = area.window
    window = rasterio.windows.Window(
        column_start,
        row_start,
        column_stop - column_start,
        row_stop - row_start,
    )
    with rasterio.open(dem_path) as dem:
        elevations = dem.read(1, window=window)
    if path is None:
        values = None
        expected = ()
    else:
        with rasterio.open(path) as dataset:
            if dataset.crs is None or dataset.crs.to_string() != area.crs:
                raise ValueError("model inputs CRS does not match simulation area")
            transform = tuple(dataset.transform)[:6]
            if (
                dataset.shape != (area.nrows, area.ncols)
                or not np.allclose(transform, area.transform)
            ):
                raise ValueError("model inputs are not aligned with the DEM")
            expected = (
                "building_fraction",
                "building_density_class",
                "manning_low",
                "manning_middle",
                "manning_high",
            )
            if dataset.descriptions != expected:
                raise ValueError("model inputs have unexpected bands")
            values = dataset.read(window=window)
    result = {
        "elevation_m": np.empty(area.cell_count, dtype=np.float32),
        **{
            name: np.full(area.cell_count, np.nan, dtype=np.float32)
            for name in (
                "building_fraction",
                "building_density_class",
                "manning_low",
                "manning_middle",
                "manning_high",
            )
        },
    }
    for index, (row, column) in enumerate(zip(
        area.cell_rows, area.cell_columns
    )):
        local_row = row - row_start
        local_column = column - column_start
        result["elevation_m"][index] = elevations[
            local_row, local_column
        ]
        if values is not None:
            cell_values = values[:, local_row, local_column]
            for name, value in zip(expected, cell_values):
                result[name][index] = value
    return result


def _finite_values(values: np.ndarray) -> list[float]:
    return [float(value) for value in values[np.isfinite(values)]]


def _summary(
    values: list[float], *, include_mean: bool = False
) -> dict[str, float]:
    result = {"minimum": min(values), "maximum": max(values)}
    if include_mean:
        result["mean"] = sum(values) / len(values)
    return result


def _write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(
        value, ensure_ascii=False, separators=(",", ":")
    ) + "\n")


def model_input_version(path: Path | str, fallback: str) -> str:
    source = Path(path)
    if not source.is_file():
        return fallback
    with rasterio.open(source) as dataset:
        version = dataset.tags().get("MODEL_INPUT_VERSION")
    if not version:
        raise RuntimeError(f"model inputs have no version tag: {source}")
    return version
