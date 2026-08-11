"""Finite-volume fill-spill routing over a preprocessed depression network.

This module is the runtime seam for the non-authoritative Bayuquan rainfall
preview. Callers supply preprocessed depression storage curves, catchments,
spill receivers, or a nested merge hierarchy. It does not model flow momentum,
infiltration, drainage, or travel time.
"""

from __future__ import annotations

import heapq
import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Depression:
    """A depression and its direct spill receiver.

    Parameters
    ----------
    id : int
        Stable, non-negative depression identifier.
    elevations_m : sequence of float or ndarray
        Elevations of cells able to store water below the spill elevation.
    spill_elevation_m : float
        Elevation at which excess volume leaves this depression.
    catchment_area_m2 : float
        Area contributing effective rainfall directly to this depression.
    downstream_id : int or None
        Receiving depression, or ``None`` for an open outlet.
    """

    id: int
    elevations_m: Sequence[float] | np.ndarray
    spill_elevation_m: float
    catchment_area_m2: float
    downstream_id: int | None = None


@dataclass(frozen=True)
class _RoutingNode:
    catchment_area_m2: float
    downstream_id: int | None


class _StorageCurve:
    """Exact piecewise-linear elevation-volume relation for one depression."""

    def __init__(
        self,
        elevations_m: Sequence[float] | np.ndarray,
        spill_elevation_m: float,
        cell_area_m2: float,
    ):
        elevations = np.asarray(elevations_m, dtype=np.float64)
        if elevations.ndim != 1 or elevations.size == 0:
            raise ValueError("a depression needs at least one storage cell")
        if not np.isfinite(elevations).all():
            raise ValueError("depression elevations must be finite")
        storage_elevations = np.sort(
            elevations[elevations < spill_elevation_m]
        )
        if storage_elevations.size == 0:
            raise ValueError(
                "a depression needs a cell below its spill elevation"
            )
        self._elevations = storage_elevations
        self._cell_area_m2 = cell_area_m2
        self.spill_elevation_m = spill_elevation_m
        self.capacity_m3 = float(
            cell_area_m2
            * np.sum(spill_elevation_m - storage_elevations)
        )

    def level_for_volume(self, volume_m3: float) -> float:
        """Invert the storage curve, capped at the spill elevation."""
        if volume_m3 <= 0.0:
            return float(self._elevations[0])
        if volume_m3 >= self.capacity_m3:
            return self.spill_elevation_m

        elevations = self._elevations
        remaining = volume_m3 / self._cell_area_m2
        level = float(elevations[0])
        wet_cells = 1
        for next_level in elevations[1:]:
            increment = (float(next_level) - level) * wet_cells
            if remaining <= increment:
                return level + remaining / wet_cells
            remaining -= increment
            level = float(next_level)
            wet_cells += 1
        return level + remaining / wet_cells


@dataclass(frozen=True)
class DepressionMerge:
    """A hierarchy node activated when all child depressions reach a saddle."""

    id: int
    child_ids: tuple[int, ...]
    elevations_m: Sequence[float] | np.ndarray
    spill_elevation_m: float


@dataclass(frozen=True)
class FillSpillResult:
    """Maximum static levels and mass accounting for one rainfall scenario."""

    maximum_level_m: dict[int, float]
    retained_volume_m3: float
    outflow_volume_m3: float
    input_volume_m3: float
    mass_balance_error_m3: float

    def depths_for(
        self,
        basin_ids: np.ndarray,
        elevations_m: np.ndarray,
    ) -> np.ndarray:
        """Restore water depths for one raster tile.

        Cells with a negative/unknown basin ID or a non-finite elevation are
        returned as NaN. This method is intended to be called tile by tile.
        """
        ids = np.asarray(basin_ids)
        elevations = np.asarray(elevations_m)
        if ids.shape != elevations.shape:
            raise ValueError("basin IDs and elevations must have the same shape")

        known_ids = np.asarray(sorted(self.maximum_level_m), dtype=np.int64)
        known_levels = np.asarray(
            [self.maximum_level_m[item] for item in known_ids],
            dtype=np.float64,
        )
        output = np.full(ids.shape, np.nan, dtype=np.float32)
        if known_ids.size == 0:
            return output

        flat_ids = ids.ravel()
        positions = np.searchsorted(known_ids, flat_ids)
        candidates = positions < known_ids.size
        matched = np.zeros(flat_ids.shape, dtype=bool)
        matched[candidates] = (
            known_ids[positions[candidates]] == flat_ids[candidates]
        )
        valid = matched & np.isfinite(elevations.ravel())
        output.ravel()[valid] = np.maximum(
            known_levels[positions[valid]] - elevations.ravel()[valid],
            0.0,
        ).astype(np.float32)
        return output


class DepressionNetwork:
    """Route one effective rainfall depth through a depression spill network.

    The public seam intentionally accepts effective rainfall depth rather than
    total precipitation. Loss models can therefore evolve independently of
    this mass-conserving storage and spill module.
    """

    def __init__(
        self,
        depressions: list[Depression] | tuple[Depression, ...],
        *,
        cell_area_m2: float,
        open_catchment_area_m2: float = 0.0,
    ):
        if not math.isfinite(cell_area_m2) or cell_area_m2 <= 0.0:
            raise ValueError("cell area must be finite and greater than zero")
        if (
            not math.isfinite(open_catchment_area_m2)
            or open_catchment_area_m2 < 0.0
        ):
            raise ValueError("open catchment area must be finite and non-negative")
        if not depressions and open_catchment_area_m2 == 0.0:
            raise ValueError("a depression network must not be empty")
        self._open_catchment_area_m2 = open_catchment_area_m2

        depressions_by_id = {item.id: item for item in depressions}
        if len(depressions_by_id) != len(depressions):
            raise ValueError("depression IDs must be unique")
        self._nodes = {}
        self._curves = {}
        for item in depressions:
            self._validate_depression(item, depressions_by_id)
            self._nodes[item.id] = _RoutingNode(
                catchment_area_m2=item.catchment_area_m2,
                downstream_id=item.downstream_id,
            )
            self._curves[item.id] = _StorageCurve(
                item.elevations_m,
                item.spill_elevation_m,
                cell_area_m2,
            )
        self._order = self._topological_order()

    def _validate_depression(
        self,
        depression: Depression,
        depressions_by_id: dict[int, Depression],
    ) -> None:
        if isinstance(depression.id, bool) or not isinstance(depression.id, int):
            raise TypeError("depression IDs must be integers")
        if depression.id < 0:
            raise ValueError("depression IDs must be non-negative")
        if not math.isfinite(depression.spill_elevation_m):
            raise ValueError("spill elevations must be finite")
        if (
            not math.isfinite(depression.catchment_area_m2)
            or depression.catchment_area_m2 <= 0.0
        ):
            raise ValueError(
                "catchment areas must be finite and greater than zero"
            )
        downstream = depression.downstream_id
        if downstream is not None and downstream not in depressions_by_id:
            raise ValueError(
                f"depression {depression.id} has unknown downstream "
                f"depression {downstream}"
            )

    def _topological_order(self) -> tuple[int, ...]:
        indegree = {item: 0 for item in self._nodes}
        for node in self._nodes.values():
            if node.downstream_id is not None:
                indegree[node.downstream_id] += 1
        ready = sorted(item for item, degree in indegree.items() if degree == 0)
        order = []
        while ready:
            current = heapq.heappop(ready)
            order.append(current)
            downstream = self._nodes[current].downstream_id
            if downstream is not None:
                indegree[downstream] -= 1
                if indegree[downstream] == 0:
                    heapq.heappush(ready, downstream)
        if len(order) != len(self._nodes):
            raise ValueError("depression spill network contains a cycle")
        return tuple(order)

    def solve(self, *, effective_rainfall_depth_m: float) -> FillSpillResult:
        """Fill and spill all depressions for one uniform rainfall depth."""
        if (
            not math.isfinite(effective_rainfall_depth_m)
            or effective_rainfall_depth_m < 0.0
        ):
            raise ValueError(
                "effective rainfall depth must be finite and non-negative"
            )

        available = {
            depression_id: effective_rainfall_depth_m * node.catchment_area_m2
            for depression_id, node in self._nodes.items()
        }
        open_runoff = (
            effective_rainfall_depth_m * self._open_catchment_area_m2
        )
        input_volume = sum(available.values()) + open_runoff
        retained = 0.0
        outflow = open_runoff
        levels = {}
        for depression_id in self._order:
            curve = self._curves[depression_id]
            volume = available[depression_id]
            stored = min(volume, curve.capacity_m3)
            overflow = max(0.0, volume - stored)
            retained += stored
            levels[depression_id] = curve.level_for_volume(stored)
            downstream = self._nodes[depression_id].downstream_id
            if downstream is None:
                outflow += overflow
            else:
                available[downstream] += overflow

        error = input_volume - retained - outflow
        return FillSpillResult(
            maximum_level_m=levels,
            retained_volume_m3=retained,
            outflow_volume_m3=outflow,
            input_volume_m3=input_volume,
            mass_balance_error_m3=error,
        )


@dataclass
class _HierarchyState:
    node_id: int
    stored_volume_m3: float
    children: list[_HierarchyState]
    shared_surface: bool = False


class DepressionHierarchy:
    """Fill nested depressions without sharing water before merge activation."""

    def __init__(
        self,
        *,
        leaves: tuple[Depression, ...] | list[Depression],
        merges: tuple[DepressionMerge, ...] | list[DepressionMerge],
        root_ids: tuple[int, ...],
        cell_area_m2: float,
        open_catchment_area_m2: float = 0.0,
    ):
        if not math.isfinite(cell_area_m2) or cell_area_m2 <= 0.0:
            raise ValueError("cell area must be finite and greater than zero")
        if (
            not math.isfinite(open_catchment_area_m2)
            or open_catchment_area_m2 < 0.0
        ):
            raise ValueError("open catchment area must be finite and non-negative")
        self._cell_area_m2 = cell_area_m2
        self._open_catchment_area_m2 = open_catchment_area_m2
        self._leaves = {item.id: item for item in leaves}
        self._merges = {item.id: item for item in merges}
        if len(self._leaves) != len(leaves) or len(self._merges) != len(merges):
            raise ValueError("hierarchy node IDs must be unique")
        if set(self._leaves) & set(self._merges):
            raise ValueError("leaf and merge IDs must be disjoint")
        self._root_ids = tuple(root_ids)
        self._curves = {
            item.id: _StorageCurve(
                item.elevations_m,
                item.spill_elevation_m,
                cell_area_m2,
            )
            for item in leaves
        }
        self._curves.update({
            item.id: _StorageCurve(
                item.elevations_m,
                item.spill_elevation_m,
                cell_area_m2,
            )
            for item in merges
        })
        self._validate()

    def _validate(self) -> None:
        all_ids = set(self._leaves) | set(self._merges)
        if not self._root_ids or not set(self._root_ids) <= all_ids:
            raise ValueError("hierarchy roots must reference known nodes")
        parents = {}
        for merge in self._merges.values():
            if len(merge.child_ids) < 2:
                raise ValueError("a depression merge needs at least two children")
            if any(item not in all_ids for item in merge.child_ids):
                raise ValueError("depression merge references an unknown child")
            child_capacity = 0.0
            child_spills = []
            for child_id in merge.child_ids:
                if child_id in parents:
                    raise ValueError("a hierarchy node cannot have two parents")
                parents[child_id] = merge.id
                child_capacity += self._curves[child_id].capacity_m3
                child_spills.append(
                    self._spill_elevation(child_id)
                )
            if not np.allclose(child_spills, child_spills[0]):
                raise ValueError("merge children must share one saddle elevation")
            if self._curves[merge.id].capacity_m3 + 1.0e-12 < child_capacity:
                raise ValueError("merge storage capacity cannot shrink")
        expected_roots = all_ids - set(parents)
        if set(self._root_ids) != expected_roots:
            raise ValueError("hierarchy roots do not cover every node")

        visiting = set()
        visited = set()

        def visit(node_id: int) -> None:
            if node_id in visiting:
                raise ValueError("depression hierarchy contains a cycle")
            if node_id in visited:
                return
            visiting.add(node_id)
            if node_id in self._merges:
                for child_id in self._merges[node_id].child_ids:
                    visit(child_id)
            visiting.remove(node_id)
            visited.add(node_id)

        for root_id in self._root_ids:
            visit(root_id)
        if visited != all_ids:
            raise ValueError("hierarchy contains unreachable nodes")

    def _spill_elevation(self, node_id: int) -> float:
        if node_id in self._leaves:
            return self._leaves[node_id].spill_elevation_m
        return self._merges[node_id].spill_elevation_m

    def _initial_state(
        self,
        node_id: int,
        rainfall_depth_m: float,
    ) -> tuple[_HierarchyState, float]:
        curve = self._curves[node_id]
        if node_id in self._leaves:
            leaf = self._leaves[node_id]
            available = rainfall_depth_m * leaf.catchment_area_m2
            stored = min(available, curve.capacity_m3)
            return _HierarchyState(node_id, stored, []), available - stored

        children = []
        overflow = 0.0
        for child_id in self._merges[node_id].child_ids:
            child, child_overflow = self._initial_state(
                child_id,
                rainfall_depth_m,
            )
            children.append(child)
            overflow += child_overflow
        state = _HierarchyState(
            node_id,
            sum(child.stored_volume_m3 for child in children),
            children,
        )
        overflow = self._add_water(state, overflow)
        return state, overflow

    def _add_water(self, state: _HierarchyState, volume_m3: float) -> float:
        if volume_m3 <= 0.0:
            return 0.0
        curve = self._curves[state.node_id]
        if not state.children:
            accepted = min(
                volume_m3,
                curve.capacity_m3 - state.stored_volume_m3,
            )
            state.stored_volume_m3 += accepted
            return volume_m3 - accepted

        if not state.shared_surface:
            remaining = volume_m3
            for child in state.children:
                if remaining <= 0.0:
                    break
                remaining = self._add_water(child, remaining)
            state.stored_volume_m3 = sum(
                child.stored_volume_m3 for child in state.children
            )
            children_full = all(
                abs(
                    child.stored_volume_m3
                    - self._curves[child.node_id].capacity_m3
                ) <= 1.0e-12
                for child in state.children
            )
            if not children_full:
                return remaining
            state.shared_surface = True
            volume_m3 = remaining

        accepted = min(
            volume_m3,
            curve.capacity_m3 - state.stored_volume_m3,
        )
        state.stored_volume_m3 += accepted
        return volume_m3 - accepted

    def _levels(self, state: _HierarchyState) -> dict[int, float]:
        curve = self._curves[state.node_id]
        if not state.children:
            return {
                state.node_id: curve.level_for_volume(
                    state.stored_volume_m3
                )
            }
        if state.shared_surface:
            level = curve.level_for_volume(state.stored_volume_m3)
            result = {}
            stack = list(state.children)
            while stack:
                child = stack.pop()
                if child.children:
                    stack.extend(child.children)
                else:
                    result[child.node_id] = level
            return result
        result = {}
        for child in state.children:
            result.update(self._levels(child))
        return result

    def solve(self, *, effective_rainfall_depth_m: float) -> FillSpillResult:
        """Solve one uniform effective rainfall depth over the hierarchy."""
        if (
            not math.isfinite(effective_rainfall_depth_m)
            or effective_rainfall_depth_m < 0.0
        ):
            raise ValueError(
                "effective rainfall depth must be finite and non-negative"
            )
        states = []
        outflow = (
            effective_rainfall_depth_m * self._open_catchment_area_m2
        )
        for root_id in self._root_ids:
            state, overflow = self._initial_state(
                root_id,
                effective_rainfall_depth_m,
            )
            states.append(state)
            outflow += overflow
        levels = {}
        retained = 0.0
        for state in states:
            levels.update(self._levels(state))
            retained += state.stored_volume_m3
        input_volume = effective_rainfall_depth_m * (
            self._open_catchment_area_m2
            + sum(item.catchment_area_m2 for item in self._leaves.values())
        )
        return FillSpillResult(
            maximum_level_m=levels,
            retained_volume_m3=retained,
            outflow_volume_m3=outflow,
            input_volume_m3=input_volume,
            mass_balance_error_m3=input_volume - retained - outflow,
        )
