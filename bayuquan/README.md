# Bayuquan local-domain simulation

This directory contains the Bayuquan Web GIS runtime. Each Job uses an
immutable, area-hashed local mesh generated from the full 30 m DEM.
See [`WEB_GIS_IMPLEMENTATION_PLAN.md`](WEB_GIS_IMPLEMENTATION_PLAN.md) for the
full product plan.

## 1. Build the static web DEM manually

Docker Compose runs this step automatically through `model-assets`. To rebuild
the COG directly:

```bash
uv run --extra data python bayuquan/build_web_map_assets.py \
  bayuquan/elevation.tif OUTPUT/model/web/elevation_cog.tif --force
```

The output is tiled, compressed, contains internal overviews, and is exposed
through `/api/model/dem/tilejson` rather than revealing its filesystem path.

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
- `frames/000000000.tif`, etc.: atomic five-band depth/stage/speed/u/v COGs;
- `report.json`: per-inlet and total water-volume/hazard report.

Each `yieldstep`, including `t=0`, is published immediately as a 75×56,
EPSG:32651 COG aligned exactly with the cropped model DEM. Dry pixels retain
their numerical values but are transparent through the internal display mask.

The result workspace can request each frame's compact, versioned flow field
from `/api/jobs/{jobId}/frames/{frameIndex}/flow` and display animated particles.
Browsers requesting reduced motion receive static directional arrows instead.

All boundaries are fixed as transmissive. Initial water level is applied only
at `t=0`; it is not maintained during evolution.

## Tests

```bash
uv run --with pytest pytest -q bayuquan/tests
```

## Local computational domains

`bayuquan.simulation.area.SimulationAreaResolver` converts one WGS84 rectangle
or simple polygon into a four-neighbour-connected mask of valid full-DEM cells.
`SimulationAreaCatalog` caches the canonical area metadata, local GeoJSON grid,
and deterministic ANUGA mesh under the configured shared simulation-area cache.

Each selected 30×30 m cell is split along the southwest–northeast diagonal into
two 450 m² triangles. A flat-water ANUGA regression verifies transmissive-boundary
volume conservation on the generated mesh.
