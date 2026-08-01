from __future__ import annotations

import pytest


def test_drainage_outlet_removes_water_at_depth_limited_capacity():
    try:
        import anuga
    except FileNotFoundError as error:
        if "ninja" not in str(error):
            raise
        pytest.skip("local meson editable install references a removed ninja")

    from bayuquan.simulation.drainage_operator import DrainageOutletOperator

    domain = anuga.rectangular_cross_domain(4, 4, len1=4, len2=4)
    domain.set_flow_algorithm("DE0")
    domain.set_store(False)
    domain.set_quantity("elevation", 0.0)
    domain.set_quantity("stage", 1.0)
    domain.set_quantity("friction", 0.03)
    domain.set_boundary({
        "left": anuga.Reflective_boundary(domain),
        "right": anuga.Reflective_boundary(domain),
        "top": anuga.Reflective_boundary(domain),
        "bottom": anuga.Reflective_boundary(domain),
    })
    operator = DrainageOutletOperator(
        domain,
        anuga.Region(domain, center=(2, 2), radius=1),
        capacity_m3s=1.0,
        full_capacity_depth_m=0.5,
        blockage=0.25,
        label="drain-1",
    )
    initial_volume = float(domain.get_water_volume())

    list(domain.evolve(yieldstep=0.1, finaltime=0.5))

    assert operator.effective_capacity_m3s == pytest.approx(0.75)
    assert operator.drained_volume_m3 > 0
    assert operator.drained_volume_m3 <= 0.75 * 0.5 + 1.0e-6
    assert domain.get_water_volume() == pytest.approx(
        initial_volume - operator.drained_volume_m3
    )
