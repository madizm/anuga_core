# Bayuquan Web GIS API and worker

## Start the phase-C services

The fixed model must be generated first. API startup applies all Alembic
migrations before accepting traffic:

```bash
bayuquan/build_grid_triangle_mapping.sh
docker compose up --build api worker postgres redis minio titiler
```

Endpoints:

- API/OpenAPI: <http://localhost:8000/docs>
- MinIO API: <http://localhost:9000>
- MinIO console: <http://localhost:9001>
- TiTiler: <http://localhost:8001>

The worker runs with concurrency 1. It loads the immutable scenario snapshot,
validates the fixed mesh and raster mapping, publishes every completed frame to
MinIO, and commits frame metadata before emitting its Redis event.

## Main API flow

```text
POST /api/scenarios
POST /api/scenarios/{id}/validate
POST /api/scenarios/{id}/jobs
GET  /api/jobs/{id}
GET  /api/jobs/{id}/frames
GET  /api/jobs/{id}/events
```

SSE reconnects use `Last-Event-ID`. PostgreSQL remains authoritative: the event
endpoint first catches up committed frames from the database, so missed Redis
events do not lose frames.

The runtime mounts only `OUTPUT/` into the containers. Service source is copied
to `/opt/webgis`, preventing the unbuilt repository `anuga/` directory from
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
