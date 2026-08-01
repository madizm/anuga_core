# Bayuquan local-domain simulation

This directory contains the Bayuquan Web GIS runtime. Each Job uses an
immutable, area-hashed local mesh generated from its selected DEM product.
See [`WEB_GIS_IMPLEMENTATION_PLAN.md`](WEB_GIS_IMPLEMENTATION_PLAN.md) for the
full product plan.

## 1. Build DEM products

Docker Compose runs this step automatically through `model-assets`. To rebuild
the COG directly:

```bash
uv run --extra data python bayuquan/build_web_map_assets.py \
  bayuquan/elevation.tif OUTPUT/model/web/elevation_cog.tif \
  --buildings OUTPUT/buildings/buildings.gpkg \
  --model-inputs-target OUTPUT/model/web/model_inputs_cog.tif \
  --derived-dem-target OUTPUT/model/web/elevation_10m_cog.tif \
  --derived-model-inputs-target OUTPUT/model/web/model_inputs_10m_cog.tif \
  --manifest-target OUTPUT/model/dem-products.json \
  --vertical-datum 'WGS 84 ellipsoidal height' --force
```

The Compose asset build creates the original 30 m product and a strictly
nested, bilinear 10 m product. Ancillary building and Manning cells are copied
nearest-neighbour into each 3 × 3 block. The 10 m grid remains explicitly
labelled as having 30 m source information resolution. Products are registered
from `OUTPUT/model/dem-products.json`, stored in MinIO under content-addressed
immutable keys, and exposed through product-scoped
`/api/dem-products/{productId}/...` endpoints. TiTiler smooths overview tiles;
the editor displays exact grid boundaries at editing zooms.

MapLibre uses this source for optional 3D terrain. The editor defaults to a 2D
orthographic view, while desktop result maps default to 3D. Both workspaces
offer 1.0×, 1.5×, and 2.0× vertical exaggeration and optional hillshade.

## 2. Define a scenario

[`default_scenario.json`](default_scenario.json) is the six-hour, 100 m³/s
baseline. An inlet is represented only by connected `cellIds`:

```json
{
  "name": "two inlet test",
  "durationSeconds": 600,
  "yieldstepSeconds": 60,
  "frictionScenario": "middle",
  "rainfall": {
    "enabled": true,
    "points": [
      {"timeMinutes": 0, "intensityMmPerHour": 50}
    ]
  },
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

Rainfall is optional and spatially uniform over the selected simulation area.
Each point starts a right-continuous step in `mm/h`; the final point lasts
until `durationSeconds`. Point times are strictly increasing whole minutes,
the first point starts at minute zero, and no infiltration loss is applied.
Scenarios may use rainfall, enabled inlets, or both.

Velocity modes are:

- `zero`;
- `components`, with `velocityUMps` (east-positive) and `velocityVMps`
  (north-positive);
- `bearing`, with `speedMps` and clockwise `bearingDegrees` from north.

Enabled inlets must have unique IDs, must not overlap, and each inlet's cells
must be four-neighbour connected.

## 3. Draw hydraulic features

The workbench compiles six map-drawn feature types into an immutable,
scenario-specific ANUGA model:

- **levees** become mesh-conforming breaklines and ANUGA `RiverWall` edges;
  crest levels may be absolute, relative to sampled terrain, or a vertex
  profile, and optional breaches lower a finite crest segment;
- **simple channels** are polygons that lower or replace terrain, override
  Manning roughness, preserve their banks as breaklines, and refine the local
  mesh;
- **engineering channels** interpolate bed elevation, bottom width, and side
  slope between cross-sections along a drawn centreline;
- **box/pipe culverts** use ANUGA's Boyd operators;
- **bridge or gate openings** use the trapezoidal weir/orifice operator.

All feature geometry is stored as OGC:CRS84 GeoJSON and projected to the DEM
CRS by the scenario compiler. The editor provides a sampled levee profile and
an on-demand preview of the final constrained mesh. Runtime reports record the
compiled mesh hash, levee/channel geometry summaries, breaches, and cumulative
structure flow.

Feature lines and polygons must stay inside the simulation area. Channel
terrain polygons cannot overlap, and breaklines currently cannot intersect;
users must draw explicitly separated features. Drawn channel depths without
surveyed bathymetry are conceptual inputs, not measured terrain.

## 4. Run

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
- Rainfall-enabled reports include effective area, cumulative depth, requested
  and applied volume, volume difference, and per-step interval details.

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
