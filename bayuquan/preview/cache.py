"""Safe, versioned persistence for local depression preprocessing products."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import numpy as np

from .fill_spill import (
    Depression,
    DepressionHierarchy,
    DepressionMerge,
    DepressionNetwork,
)
from .preprocessing import PreprocessedDem

SCHEMA_VERSION = 2


class PreprocessingCacheMismatch(ValueError):
    """Raised when a cache does not describe the requested terrain window."""


def cache_identity(
    *,
    dem_path: Path | str,
    window: tuple[int, int, int, int],
    transform: tuple[float, ...],
) -> str:
    """Return a deterministic local identity for immutable preprocessing input."""
    path = Path(dem_path).resolve()
    stat = path.stat()
    return json.dumps({
        "schemaVersion": SCHEMA_VERSION,
        "demPath": str(path),
        "demSizeBytes": stat.st_size,
        "demModifiedNs": stat.st_mtime_ns,
        "window": list(window),
        "transform": list(transform),
    }, sort_keys=True, separators=(",", ":"))


def save_preprocessed(
    path: Path | str,
    preprocessed: PreprocessedDem,
    *,
    identity: str,
) -> None:
    """Atomically save compact numeric arrays without Python object pickles."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    depressions = preprocessed.depressions
    offsets = np.zeros(len(depressions) + 1, dtype=np.int64)
    arrays = []
    for index, depression in enumerate(depressions):
        values = np.asarray(depression.elevations_m, dtype=np.float32)
        arrays.append(values)
        offsets[index + 1] = offsets[index] + values.size
    elevations = (
        np.concatenate(arrays)
        if arrays
        else np.empty(0, dtype=np.float32)
    )
    downstream = np.asarray([
        -1 if item.downstream_id is None else item.downstream_id
        for item in depressions
    ], dtype=np.int32)

    merges = preprocessed.merges
    merge_child_offsets = np.zeros(len(merges) + 1, dtype=np.int64)
    merge_elevation_offsets = np.zeros(len(merges) + 1, dtype=np.int64)
    merge_children = []
    merge_elevations = []
    for index, merge in enumerate(merges):
        merge_children.extend(merge.child_ids)
        values = np.asarray(merge.elevations_m, dtype=np.float32)
        merge_elevations.append(values)
        merge_child_offsets[index + 1] = len(merge_children)
        merge_elevation_offsets[index + 1] = (
            merge_elevation_offsets[index] + values.size
        )

    descriptor, temporary_name = tempfile.mkstemp(
        dir=target.parent,
        suffix=".npz",
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with temporary.open("wb") as stream:
            np.savez_compressed(
                stream,
                schema_version=np.asarray(SCHEMA_VERSION, dtype=np.int32),
                identity=np.asarray(identity),
                basin_ids=np.asarray(
                    preprocessed.basin_ids,
                    dtype=np.int32,
                ),
                filled_elevations_m=np.asarray(
                    preprocessed.filled_elevations_m,
                    dtype=np.float32,
                ),
                cell_area_m2=np.asarray(
                    preprocessed.cell_area_m2,
                    dtype=np.float64,
                ),
                depression_ids=np.asarray(
                    [item.id for item in depressions],
                    dtype=np.int32,
                ),
                spill_elevations_m=np.asarray(
                    [item.spill_elevation_m for item in depressions],
                    dtype=np.float64,
                ),
                catchment_areas_m2=np.asarray(
                    [item.catchment_area_m2 for item in depressions],
                    dtype=np.float64,
                ),
                downstream_ids=downstream,
                elevation_offsets=offsets,
                storage_elevations_m=elevations,
                merge_ids=np.asarray(
                    [item.id for item in merges],
                    dtype=np.int32,
                ),
                merge_spill_elevations_m=np.asarray(
                    [item.spill_elevation_m for item in merges],
                    dtype=np.float64,
                ),
                merge_child_offsets=merge_child_offsets,
                merge_children=np.asarray(merge_children, dtype=np.int32),
                merge_elevation_offsets=merge_elevation_offsets,
                merge_elevations_m=(
                    np.concatenate(merge_elevations)
                    if merge_elevations
                    else np.empty(0, dtype=np.float32)
                ),
                root_ids=np.asarray(
                    preprocessed.root_ids,
                    dtype=np.int32,
                ),
            )
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def load_preprocessed(
    path: Path | str,
    *,
    expected_identity: str,
) -> PreprocessedDem:
    """Load and validate a preprocessing cache without enabling pickle."""
    try:
        archive_context = np.load(path, allow_pickle=False)
    except (OSError, ValueError) as error:
        raise PreprocessingCacheMismatch(
            "cannot read preprocessing cache"
        ) from error
    with archive_context as archive:
        try:
            schema = int(archive["schema_version"].item())
            identity = str(archive["identity"].item())
            basin_ids = np.asarray(archive["basin_ids"], dtype=np.int32)
            filled = np.asarray(
                archive["filled_elevations_m"],
                dtype=np.float32,
            )
            cell_area = float(archive["cell_area_m2"].item())
            depression_ids = np.asarray(
                archive["depression_ids"],
                dtype=np.int32,
            )
            spills = np.asarray(
                archive["spill_elevations_m"],
                dtype=np.float64,
            )
            catchments = np.asarray(
                archive["catchment_areas_m2"],
                dtype=np.float64,
            )
            downstream = np.asarray(
                archive["downstream_ids"],
                dtype=np.int32,
            )
            offsets = np.asarray(
                archive["elevation_offsets"],
                dtype=np.int64,
            )
            storage = np.asarray(
                archive["storage_elevations_m"],
                dtype=np.float32,
            )
            merge_ids = np.asarray(archive["merge_ids"], dtype=np.int32)
            merge_spills = np.asarray(
                archive["merge_spill_elevations_m"],
                dtype=np.float64,
            )
            merge_child_offsets = np.asarray(
                archive["merge_child_offsets"],
                dtype=np.int64,
            )
            merge_children = np.asarray(
                archive["merge_children"],
                dtype=np.int32,
            )
            merge_elevation_offsets = np.asarray(
                archive["merge_elevation_offsets"],
                dtype=np.int64,
            )
            merge_elevations = np.asarray(
                archive["merge_elevations_m"],
                dtype=np.float32,
            )
            root_ids = tuple(
                int(item) for item in np.asarray(
                    archive["root_ids"],
                    dtype=np.int32,
                )
            )
        except (KeyError, TypeError, ValueError) as error:
            raise PreprocessingCacheMismatch(
                "preprocessing cache is incomplete"
            ) from error

    if schema != SCHEMA_VERSION or identity != expected_identity:
        raise PreprocessingCacheMismatch(
            "preprocessing cache identity does not match DEM input"
        )
    count = depression_ids.size
    merge_count = merge_ids.size
    if not (
        basin_ids.ndim == 2
        and filled.shape == basin_ids.shape
        and spills.size == count
        and catchments.size == count
        and downstream.size == count
        and offsets.shape == (count + 1,)
        and offsets[0] == 0
        and offsets[-1] == storage.size
        and np.all(offsets[1:] >= offsets[:-1])
        and merge_spills.size == merge_count
        and merge_child_offsets.shape == (merge_count + 1,)
        and merge_child_offsets[0] == 0
        and merge_child_offsets[-1] == merge_children.size
        and np.all(merge_child_offsets[1:] >= merge_child_offsets[:-1])
        and merge_elevation_offsets.shape == (merge_count + 1,)
        and merge_elevation_offsets[0] == 0
        and merge_elevation_offsets[-1] == merge_elevations.size
        and np.all(
            merge_elevation_offsets[1:] >= merge_elevation_offsets[:-1]
        )
    ):
        raise PreprocessingCacheMismatch(
            "preprocessing cache array dimensions are invalid"
        )

    depressions = tuple(
        Depression(
            id=int(depression_ids[index]),
            elevations_m=storage[offsets[index]:offsets[index + 1]],
            spill_elevation_m=float(spills[index]),
            catchment_area_m2=float(catchments[index]),
            downstream_id=(
                None
                if downstream[index] < 0
                else int(downstream[index])
            ),
        )
        for index in range(count)
    )
    merges = tuple(
        DepressionMerge(
            id=int(merge_ids[index]),
            child_ids=tuple(
                int(item) for item in merge_children[
                    merge_child_offsets[index]:merge_child_offsets[index + 1]
                ]
            ),
            elevations_m=merge_elevations[
                merge_elevation_offsets[index]:
                merge_elevation_offsets[index + 1]
            ],
            spill_elevation_m=float(merge_spills[index]),
        )
        for index in range(merge_count)
    )
    valid = np.isfinite(filled)
    open_area = float(np.count_nonzero(valid & (basin_ids < 0))) * cell_area
    if depressions:
        network = DepressionHierarchy(
            leaves=depressions,
            merges=merges,
            root_ids=root_ids,
            cell_area_m2=cell_area,
            open_catchment_area_m2=open_area,
        )
    else:
        network = DepressionNetwork(
            depressions,
            cell_area_m2=cell_area,
            open_catchment_area_m2=open_area,
        )
    return PreprocessedDem(
        basin_ids=basin_ids,
        filled_elevations_m=filled,
        depressions=depressions,
        network=network,
        cell_area_m2=cell_area,
        merges=merges,
        root_ids=root_ids,
    )
