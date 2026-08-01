"""Single-point, capacity-limited drainage from a two-dimensional domain."""

from __future__ import annotations

from anuga.structures.inlet_operator import Inlet_operator


class DrainageOutletOperator(Inlet_operator):
    """Remove surface water through an external outlet without tailwater.

    Capacity ramps linearly with average inlet depth and reaches its effective
    maximum at ``full_capacity_depth_m``. ``Inlet_operator`` limits extraction
    to the water physically available in the intake region, preserving a
    consistent domain volume balance.
    """

    def __init__(
        self,
        domain,
        region,
        *,
        capacity_m3s: float,
        full_capacity_depth_m: float,
        blockage: float = 0.0,
        label: str | None = None,
        description: str | None = None,
    ) -> None:
        if capacity_m3s <= 0:
            raise ValueError("capacity_m3s must be greater than zero")
        if full_capacity_depth_m <= 0:
            raise ValueError("full_capacity_depth_m must be greater than zero")
        if not 0 <= blockage < 1:
            raise ValueError("blockage must be between zero and one")
        self.capacity_m3s = float(capacity_m3s)
        self.full_capacity_depth_m = float(full_capacity_depth_m)
        self.blockage = float(blockage)
        super().__init__(
            domain,
            region,
            Q=self._requested_q,
            zero_velocity=False,
            label=label,
            description=description,
            logging=False,
            verbose=False,
        )

    @property
    def effective_capacity_m3s(self) -> float:
        return self.capacity_m3s * (1.0 - self.blockage)

    @property
    def drained_volume_m3(self) -> float:
        return max(0.0, -float(self.total_applied_volume))

    @property
    def discharge_m3s(self) -> float:
        return max(0.0, -float(self.applied_Q))

    def _requested_q(self, _time: float) -> float:
        depth = max(0.0, float(self.inlet.get_average_depth()))
        capacity_fraction = min(1.0, depth / self.full_capacity_depth_m)
        return -self.effective_capacity_m3s * capacity_fraction
