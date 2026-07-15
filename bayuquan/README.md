# Bayuquan fixed-model simulation

This directory contains the first implementation stage of the Bayuquan Web GIS:
a validated, configuration-driven ANUGA worker runtime using one immutable mesh.
See [`WEB_GIS_IMPLEMENTATION_PLAN.md`](WEB_GIS_IMPLEMENTATION_PLAN.md) for the
full product plan.

## 1. Build fixed model mapping

```bash
bayuquan/build_grid_triangle_mapping.sh
```

This creates the shared mesh, authoritative 30 m cell-to-triangle mapping, and
pixel-centre barycentric interpolation mapping in `OUTPUT/model/grid_mapping/`.
Every run verifies the mesh SHA-256, triangle count, raster dimensions,
resolution, and origin before simulation starts.

## 2. Define a scenario

[`default_scenario.json`](default_scenario.json) is the six-hour, 100 m³/s
baseline. An inlet is represented only by connected `cellIds`:

```json
{
  "name": "two inlet test",
  "durationSeconds": 600,
  "yieldstepSeconds": 60,
  "frictionScenario": "middle",
  "inlets": [
    {
      "id": "inlet-001",
      "enabled": true,
      "cellIds": ["r0000-c0000", "r0000-c0001"],
      "dischargeM3s": 100,
      "velocityMode": "zero",
      "initialWaterLevelM": null
    }
  ]
}
```

Velocity modes are:

- `zero`;
- `components`, with `velocityUMps` (east-positive) and `velocityVMps`
  (north-positive);
- `bearing`, with `speedMps` and clockwise `bearingDegrees` from north.

Enabled inlets must have unique IDs, must not overlap, and each inlet's cells
must be four-neighbour connected.

## 3. Run

Using Docker:

```bash
bayuquan/run_in_docker.sh \
  --scenario /workspace/bayuquan/default_scenario.json \
  --output-dir /workspace/OUTPUT/model/web_gis_run
```

From a configured local environment:

```bash
uv run --with rasterio python -m bayuquan.run_constant_inflow \
  --project-root "$PWD" \
  --scenario bayuquan/default_scenario.json \
  --output-dir OUTPUT/model/web_gis_run
```

The output contains:

- `scenario.json`: exact immutable input snapshot;
- `model.sww`: ANUGA result;
- `frames/000000000.tif`, etc.: atomic three-band depth/stage/speed COGs;
- `report.json`: per-inlet and total water-volume/hazard report.

Each `yieldstep`, including `t=0`, is published immediately as a 75×56,
EPSG:32651 COG aligned exactly with the cropped model DEM. Dry pixels retain
their numerical values but are transparent through the internal display mask.

All boundaries are fixed as transmissive. Initial water level is applied only
at `t=0`; it is not maintained during evolution.

## Tests

```bash
uv run --with pytest pytest -q bayuquan/tests
```
