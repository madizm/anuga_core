# Bayuquan Web GIS API and worker

## Start the phase-C services

The one-shot `model-assets` service creates immutable 30 m and aligned 10 m
DEM products, their building/Manning COGs, and the administrator registration
manifest. The COGs are uploaded under content-addressed keys in the
`model-products` MinIO bucket; the database stores their immutable S3 URIs and
checksums. Both products use WGS 84 ellipsoidal height as their vertical
reference. API startup applies migrations and registers the manifest before
accepting traffic:

```bash
docker compose up --build
```

The simulation workers use ANUGA's compiled OpenMP kernels with four threads
per job by default. Override that value when starting Compose, for example
`ANUGA_OMP_NUM_THREADS=1 docker compose up --build`, to benchmark thread counts
on the target host. Keep the combined thread count of the standard and
high-resource workers within the host's available CPU cores.

Endpoints:

- API/OpenAPI: <http://localhost:8000/docs>
- MinIO API: <http://localhost:9000>
- MinIO console: <http://localhost:9001>
- TiTiler: <http://localhost:8001>

Standard and high-resource workers each run with concurrency 1. The 10 m
product uses the high-resource queue. A worker loads the immutable area and scenario
snapshot, validates the cached local mesh, publishes every completed frame to
MinIO, and commits frame metadata before emitting its Redis event.

## Main API flow

```text
POST /api/scenarios
GET  /api/scenarios
GET  /api/scenarios/{id}
GET  /api/dem-products
POST /api/dem-products/{productId}/simulation-areas/resolve
GET  /api/dem-products/{productId}/simulation-areas/{id}
GET  /api/dem-products/{productId}/simulation-areas/{id}/grid
POST /api/scenarios/{id}/validate
POST /api/scenarios/{id}/jobs
GET  /api/jobs/{id}
GET  /api/jobs/{id}/frames
GET  /api/jobs/{id}/events
GET  /api/dem-products/{productId}/tilejson
GET  /api/dem-products/{productId}/tiles/{z}/{x}/{y}.png
```

SSE reconnects use `Last-Event-ID`. PostgreSQL remains authoritative: the event
endpoint first catches up committed frames from the database, so missed Redis
events do not lose frames.

The runtime mounts `OUTPUT/` into API, Worker, and TiTiler. The one-shot asset
builder additionally mounts `bayuquan/elevation.tif` read-only and atomically
publishes both product bundles and `dem-products.json`. Service source is copied to
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
POST /api/dem-products/bayuquan-dem-10m-bilinear-v1/simulation-areas/resolve
Content-Type: application/json

{"geometry":{"type":"Polygon","coordinates":[...]}}
```

The geometry is WGS84 GeoJSON. The resolver projects it to EPSG:32651, selects
valid DEM cells by centre point, rejects any extent/NoData violation and
holes/disconnected masks, and enforces the selected product's cell limit. It
then caches a deterministic two-triangle-per-cell mesh by area hash. The 30 m
product allows 25,000 cells; the default 10 m product allows 125,000 cells.
Load only that area's grid from the returned `gridUrl`.

Scenario and Job snapshots retain both the product ID and immutable area hash. The worker loads the
cached local mesh, assigns DEM/Manning values from the versioned full-domain
model-input COG, and writes frame COGs aligned to that area's DEM window.
