"""Priority-Flood preprocessing for small fill-spill preview domains.

The implementation is intentionally CPU-only and uses compact NumPy rasters.
Its heap traversal is suitable for local validation windows. Whole-product
preprocessing will require a tiled/external-memory implementation before the
59-million-cell 5 m DEM is processed in production.
"""

from __future__ import annotations

import heapq
import math
from collections import deque
from dataclasses import dataclass

import numpy as np

from .fill_spill import (
    Depression,
    DepressionHierarchy,
    DepressionMerge,
    DepressionNetwork,
)

_NEIGHBOURS = (
    (-1, -1), (-1, 0), (-1, 1),
    (0, -1), (0, 1),
    (1, -1), (1, 0), (1, 1),
)


@dataclass(frozen=True)
class PreprocessedDem:
    """Terrain products needed by the runtime fill-spill solver."""

    basin_ids: np.ndarray
    filled_elevations_m: np.ndarray
    depressions: tuple[Depression, ...]
    network: DepressionNetwork | DepressionHierarchy
    cell_area_m2: float
    merges: tuple[DepressionMerge, ...] = ()
    root_ids: tuple[int, ...] = ()


def _default_open_boundary(valid: np.ndarray) -> np.ndarray:
    open_boundary = np.zeros(valid.shape, dtype=bool)
    open_boundary[0, :] = valid[0, :]
    open_boundary[-1, :] = valid[-1, :]
    open_boundary[:, 0] = valid[:, 0]
    open_boundary[:, -1] = valid[:, -1]
    return open_boundary


def _priority_flood(
    elevations: np.ndarray,
    valid: np.ndarray,
    open_boundary: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    rows, columns = elevations.shape
    filled = np.full(elevations.shape, np.nan, dtype=np.float64)
    parent = np.full(elevations.size, -1, dtype=np.int64)
    visited = np.zeros(elevations.shape, dtype=bool)
    heap: list[tuple[float, int]] = []

    for row, column in np.argwhere(open_boundary):
        index = int(row * columns + column)
        level = float(elevations[row, column])
        filled[row, column] = level
        visited[row, column] = True
        heapq.heappush(heap, (level, index))

    while heap:
        level, index = heapq.heappop(heap)
        row, column = divmod(index, columns)
        for row_offset, column_offset in _NEIGHBOURS:
            neighbour_row = row + row_offset
            neighbour_column = column + column_offset
            if not (
                0 <= neighbour_row < rows
                and 0 <= neighbour_column < columns
            ):
                continue
            if (
                visited[neighbour_row, neighbour_column]
                or not valid[neighbour_row, neighbour_column]
            ):
                continue
            visited[neighbour_row, neighbour_column] = True
            neighbour_index = neighbour_row * columns + neighbour_column
            neighbour_level = max(
                level,
                float(elevations[neighbour_row, neighbour_column]),
            )
            filled[neighbour_row, neighbour_column] = neighbour_level
            parent[neighbour_index] = index
            heapq.heappush(heap, (neighbour_level, neighbour_index))

    if np.any(valid & ~visited):
        raise ValueError(
            "valid DEM cells must be connected to an open outlet"
        )
    return filled, parent



def _assign_catchments(
    storage_labels: np.ndarray,
    receivers: np.ndarray,
    valid: np.ndarray,
) -> np.ndarray:
    basin_ids = storage_labels.copy()
    flat_basins = basin_ids.ravel()
    flat_valid = valid.ravel()
    resolved = (~flat_valid) | (flat_basins >= 0) | (receivers < 0)
    for start in np.flatnonzero(flat_valid & (flat_basins < 0)):
        if resolved[start]:
            continue
        trail = []
        current = int(start)
        while current >= 0 and not resolved[current]:
            trail.append(current)
            current = int(receivers[current])
        basin_id = -1 if current < 0 else int(flat_basins[current])
        for index in trail:
            flat_basins[index] = basin_id
            resolved[index] = True
    return basin_ids




def _watershed_seeds_and_receivers(
    elevations: np.ndarray,
    valid: np.ndarray,
    open_boundary: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, int]:
    """Route equal-elevation plateaus to lower terrain or make pit leaves."""
    rows, columns = elevations.shape
    plateau_ids = np.full(elevations.shape, -1, dtype=np.int32)
    plateaus: list[list[int]] = []
    for start_row, start_column in np.argwhere(valid):
        if plateau_ids[start_row, start_column] >= 0:
            continue
        plateau_id = len(plateaus)
        level = elevations[start_row, start_column]
        start = int(start_row * columns + start_column)
        plateau_ids[start_row, start_column] = plateau_id
        cells = [start]
        stack = [start]
        while stack:
            index = stack.pop()
            row, column = divmod(index, columns)
            for row_offset, column_offset in _NEIGHBOURS:
                neighbour_row = row + row_offset
                neighbour_column = column + column_offset
                if not (
                    0 <= neighbour_row < rows
                    and 0 <= neighbour_column < columns
                    and valid[neighbour_row, neighbour_column]
                    and plateau_ids[neighbour_row, neighbour_column] < 0
                    and np.isclose(
                        elevations[neighbour_row, neighbour_column],
                        level,
                        rtol=0.0,
                        atol=1.0e-9,
                    )
                ):
                    continue
                neighbour = neighbour_row * columns + neighbour_column
                plateau_ids[neighbour_row, neighbour_column] = plateau_id
                cells.append(neighbour)
                stack.append(neighbour)
        plateaus.append(cells)

    receivers = np.full(elevations.size, -1, dtype=np.int64)
    seed_labels = np.full(elevations.shape, -1, dtype=np.int32)
    leaf_count = 0
    flat_open = open_boundary.ravel()
    flat_elevations = elevations.ravel()
    for plateau_id, cells in enumerate(plateaus):
        open_cells = [index for index in cells if flat_open[index]]
        exit_cell = min(open_cells) if open_cells else None
        exit_receiver = -1
        if exit_cell is None:
            lower_edges = []
            for index in cells:
                row, column = divmod(index, columns)
                for row_offset, column_offset in _NEIGHBOURS:
                    neighbour_row = row + row_offset
                    neighbour_column = column + column_offset
                    if not (
                        0 <= neighbour_row < rows
                        and 0 <= neighbour_column < columns
                        and valid[neighbour_row, neighbour_column]
                    ):
                        continue
                    neighbour = neighbour_row * columns + neighbour_column
                    if flat_elevations[neighbour] < flat_elevations[index]:
                        descent = (
                            float(flat_elevations[index])
                            - float(flat_elevations[neighbour])
                        ) / math.hypot(row_offset, column_offset)
                        lower_edges.append((
                            -descent,
                            neighbour,
                            index,
                        ))
            if lower_edges:
                _, exit_receiver, exit_cell = min(lower_edges)

        if exit_cell is None:
            for index in cells:
                seed_labels.ravel()[index] = leaf_count
            leaf_count += 1
            continue

        receivers[exit_cell] = exit_receiver
        visited = {exit_cell}
        queue = deque([exit_cell])
        while queue:
            current = queue.popleft()
            row, column = divmod(current, columns)
            for row_offset, column_offset in _NEIGHBOURS:
                neighbour_row = row + row_offset
                neighbour_column = column + column_offset
                if not (
                    0 <= neighbour_row < rows
                    and 0 <= neighbour_column < columns
                ):
                    continue
                neighbour = neighbour_row * columns + neighbour_column
                if (
                    neighbour in visited
                    or plateau_ids[neighbour_row, neighbour_column]
                    != plateau_id
                ):
                    continue
                visited.add(neighbour)
                receivers[neighbour] = current
                queue.append(neighbour)
    return seed_labels, receivers, leaf_count


def _hierarchy_from_watersheds(
    elevations: np.ndarray,
    valid: np.ndarray,
    basin_ids: np.ndarray,
    leaf_count: int,
    cell_area_m2: float,
) -> tuple[
    tuple[Depression, ...],
    tuple[DepressionMerge, ...],
    tuple[int, ...],
    DepressionHierarchy,
]:
    rows, columns = elevations.shape
    edges: dict[tuple[int, int], float] = {}
    for row, column in np.argwhere(valid):
        basin = int(basin_ids[row, column])
        for row_offset, column_offset in ((0, 1), (1, -1), (1, 0), (1, 1)):
            neighbour_row = row + row_offset
            neighbour_column = column + column_offset
            if not (
                0 <= neighbour_row < rows
                and 0 <= neighbour_column < columns
                and valid[neighbour_row, neighbour_column]
            ):
                continue
            neighbour_basin = int(
                basin_ids[neighbour_row, neighbour_column]
            )
            if basin == neighbour_basin or (basin < 0 and neighbour_basin < 0):
                continue
            pair = tuple(sorted((basin, neighbour_basin)))
            saddle = max(
                float(elevations[row, column]),
                float(elevations[neighbour_row, neighbour_column]),
            )
            edges[pair] = min(edges.get(pair, np.inf), saddle)

    outlet = leaf_count
    parent = np.arange(leaf_count + 1, dtype=np.int32)
    rank = np.zeros(leaf_count + 1, dtype=np.int8)
    payload: list[int | None] = list(range(leaf_count)) + [None]

    def find(item: int) -> int:
        while parent[item] != item:
            parent[item] = parent[parent[item]]
            item = int(parent[item])
        return item

    def union(left: int, right: int, node_id: int | None) -> int:
        left = find(left)
        right = find(right)
        if rank[left] < rank[right]:
            left, right = right, left
        parent[right] = left
        if rank[left] == rank[right]:
            rank[left] += 1
        payload[left] = node_id
        return left

    node_children: dict[int, tuple[int, ...]] = {}
    node_spills: dict[int, float] = {}
    root_ids = []
    next_node_id = leaf_count
    sorted_edges = sorted(
        (saddle, pair[0], pair[1]) for pair, saddle in edges.items()
    )
    for saddle, left_basin, right_basin in sorted_edges:
        left_item = outlet if left_basin < 0 else left_basin
        right_item = outlet if right_basin < 0 else right_basin
        left_root = find(left_item)
        right_root = find(right_item)
        if left_root == right_root:
            continue
        left_node = payload[left_root]
        right_node = payload[right_root]
        if left_node is None and right_node is None:
            union(left_root, right_root, None)
        elif left_node is None or right_node is None:
            closed_node = right_node if left_node is None else left_node
            node_spills[closed_node] = saddle
            root_ids.append(closed_node)
            union(left_root, right_root, None)
        else:
            node_spills[left_node] = saddle
            node_spills[right_node] = saddle
            node_children[next_node_id] = (left_node, right_node)
            union(left_root, right_root, next_node_id)
            next_node_id += 1

    if any(find(index) != find(outlet) for index in range(leaf_count)):
        raise ValueError("every depression must connect to an open outlet")

    node_leaves = {index: (index,) for index in range(leaf_count)}
    for node_id in range(leaf_count, next_node_id):
        node_leaves[node_id] = tuple(
            leaf
            for child in node_children[node_id]
            for leaf in node_leaves[child]
        )
    depressions = tuple(
        Depression(
            id=leaf_id,
            elevations_m=elevations[basin_ids == leaf_id].astype(np.float32),
            spill_elevation_m=node_spills[leaf_id],
            catchment_area_m2=(
                float(np.count_nonzero(basin_ids == leaf_id)) * cell_area_m2
            ),
        )
        for leaf_id in range(leaf_count)
    )
    merges = tuple(
        DepressionMerge(
            id=node_id,
            child_ids=node_children[node_id],
            elevations_m=elevations[
                np.isin(basin_ids, node_leaves[node_id])
            ].astype(np.float32),
            spill_elevation_m=node_spills[node_id],
        )
        for node_id in range(leaf_count, next_node_id)
    )
    open_area = float(np.count_nonzero(valid & (basin_ids < 0))) * cell_area_m2
    hierarchy = DepressionHierarchy(
        leaves=depressions,
        merges=merges,
        root_ids=tuple(root_ids),
        cell_area_m2=cell_area_m2,
        open_catchment_area_m2=open_area,
    )
    return depressions, merges, tuple(root_ids), hierarchy

def preprocess_dem(
    elevations_m: np.ndarray,
    *,
    cell_area_m2: float,
    valid_mask: np.ndarray | None = None,
    open_boundary_mask: np.ndarray | None = None,
) -> PreprocessedDem:
    """Build a depression spill network from a small regular-grid DEM.

    Parameters
    ----------
    elevations_m : ndarray
        Two-dimensional terrain elevations in metres.
    cell_area_m2 : float
        Plan area represented by one cell.
    valid_mask : ndarray, optional
        Cells participating in preprocessing. Finite cells are used by default.
    open_boundary_mask : ndarray, optional
        Valid cells through which water may leave. The valid raster perimeter
        is open by default.
    """
    elevations = np.asarray(elevations_m, dtype=np.float64)
    if elevations.ndim != 2 or 0 in elevations.shape:
        raise ValueError("elevations must be a non-empty two-dimensional array")
    finite = np.isfinite(elevations)
    valid = finite if valid_mask is None else np.asarray(valid_mask, dtype=bool)
    if valid.shape != elevations.shape:
        raise ValueError("valid mask must match DEM shape")
    valid = valid & finite
    if not np.any(valid):
        raise ValueError("DEM must contain at least one valid cell")

    if open_boundary_mask is None:
        open_boundary = _default_open_boundary(valid)
    else:
        open_boundary = np.asarray(open_boundary_mask, dtype=bool)
        if open_boundary.shape != elevations.shape:
            raise ValueError("open boundary mask must match DEM shape")
        if np.any(open_boundary & ~valid):
            raise ValueError("open boundary cells must be valid DEM cells")
    if not np.any(open_boundary):
        raise ValueError("at least one open boundary cell is required")

    filled, _ = _priority_flood(elevations, valid, open_boundary)
    seed_labels, receivers, leaf_count = _watershed_seeds_and_receivers(
        elevations,
        valid,
        open_boundary,
    )
    basin_ids = _assign_catchments(seed_labels, receivers, valid)
    open_area = float(np.count_nonzero(valid & (basin_ids < 0))) * cell_area_m2
    if leaf_count:
        depressions, merges, root_ids, network = _hierarchy_from_watersheds(
            elevations,
            valid,
            basin_ids,
            leaf_count,
            cell_area_m2,
        )
    else:
        depressions = ()
        merges = ()
        root_ids = ()
        network = DepressionNetwork(
            depressions,
            cell_area_m2=cell_area_m2,
            open_catchment_area_m2=open_area,
        )
    return PreprocessedDem(
        basin_ids=basin_ids,
        filled_elevations_m=filled,
        depressions=tuple(depressions),
        network=network,
        cell_area_m2=cell_area_m2,
        merges=tuple(merges),
        root_ids=tuple(root_ids),
    )
