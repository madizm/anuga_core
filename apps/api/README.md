# Bayuquan Web GIS API and worker

## Start the phase-C services

The one-shot `model-assets` service creates the full-domain DEM and versioned
building/Manning COGs. API startup applies all Alembic migrations before
accepting traffic:

```bash
docker compose up --build api worker postgres redis minio titiler
```

Endpoints:

- API/OpenAPI: <http://localhost:8000/docs>
- MinIO API: <http://localhost:9000>
- MinIO console: <http://localhost:9001>
- TiTiler: <http://localhost:8001>

The worker runs with concurrency 1. It loads the immutable area and scenario
snapshot, validates the cached local mesh, publishes every completed frame to
MinIO, and commits frame metadata before emitting its Redis event.

## Main API flow

```text
POST /api/scenarios
POST /api/model/simulation-areas/resolve
GET  /api/model/simulation-areas/{id}/grid
POST /api/scenarios/{id}/validate
POST /api/scenarios/{id}/jobs
GET  /api/jobs/{id}
GET  /api/jobs/{id}/frames
GET  /api/jobs/{id}/events
GET  /api/model/dem/tilejson
GET  /api/model/dem/tiles/{z}/{x}/{y}.png
```

SSE reconnects use `Last-Event-ID`. PostgreSQL remains authoritative: the event
endpoint first catches up committed frames from the database, so missed Redis
events do not lose frames.

The runtime mounts `OUTPUT/` into API, Worker, and TiTiler. The one-shot asset
builder additionally mounts `bayuquan/elevation.tif` read-only and atomically
publishes `elevation_cog.tif` and `model_inputs_cog.tif`. Service source is copied to
`/opt/webgis`, preventing the unbuilt repository `anuga/` directory from
shadowing the compiled ANUGA wheel.

Stop services without deleting persistent PostgreSQL, Redis, or MinIO volumes:

```bash
docker compose down
```

## Tests

```bash
uv run --extra web-gis --extra data --extra dev --with httpx2 \
  pytest -q apps/api/tests bayuquan/tests
```

`httpx2` is currently needed only by Starlette's TestClient on Python 3.14.
Python 3.12 deployments use the normal web dependencies.

## Local simulation areas

The editor must resolve and lock a local domain before inlet editing:

```http
POST /api/model/simulation-areas/resolve
Content-Type: application/json

{"geometry":{"type":"Polygon","coordinates":[...]}}
```

The geometry is WGS84 GeoJSON. The resolver projects it to EPSG:32651, selects
valid DEM cells by centre point, rejects holes/disconnected masks and areas over
25,000 cells, then caches a deterministic two-triangle-per-cell mesh by area
hash. Load only that area's grid from the returned `gridUrl`.

Scenario and Job snapshots retain the immutable area hash. The worker loads the
cached local mesh, assigns DEM/Manning values from the versioned full-domain
model-input COG, and writes frame COGs aligned to that area's DEM window.
