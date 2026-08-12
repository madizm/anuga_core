# Bayuquan Web GIS console

A React, TypeScript, and MapLibre console for local ANUGA simulations and the
separate non-authoritative regional rainfall preview.

## Development

Start the API stack, then Vite:

```bash
docker compose up -d postgres redis minio titiler api worker \
  high-resource-worker full-preview-worker celery-beat
cd apps/web
npm install
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` to port 8000.

## Routes

- `/workbench/local` opens the local-domain editor;
- `/simulations/:jobId` is the reload-safe formal simulation result route;
- `/workbench/regional-preview` opens the regional preview submission and
  history console;
- `/previews/:previewId` is the reload-safe regional preview result route.

The regional console accepts one 24-hour accumulated-rainfall value. It always
shows the configured runoff coefficient, derived effective rainfall, fixed
assumptions, cache readiness, and non-authoritative status. Submission remains
disabled when the API reports that the fixed domain or versioned preprocessing
cache is unavailable; it does not fall back to browser GPU preview or an
in-memory full-DEM preprocessing run.

A completed preview displays a static maximum-water-depth map with threshold
area statistics and point sampling. Operators can download its COG, copy its
rainfall value into another run, and overlay a completed result only when its
dataset, fixed domain, cache, and assumptions compatibility version matches.

## Supported editor interactions

- rectangle or simple-polygon local simulation-area selection;
- server-resolved, area-hashed local 5 m computational grid;
- single-cell toggle;
- Shift-add and Alt-remove;
- continuous brush selection;
- rectangular selection;
- default 5 m DEM COG tiles with terrain legend and visibility control;
- 5 m vector contours with 25 m major lines and MapLibre elevation labels on every contour;
- viewport-scoped topology and field tiles; tile-local instanced buffers are cached and reused during zoom;
- contours are generated per loaded tile during idle time and hidden below the detail zoom threshold;
- building-coverage overlay and scenario-aware Manning surface layer;
- multiple independently colored inlets;
- overlap prevention and four-neighbour connectivity status;
- discharge, velocity components/bearing, and initial water level;
- server-resolved triangle, hydraulic-area, elevation, and Manning statistics;
- transactional scenario save, validation, warning confirmation, and Job submit.
- updated-at-sorted scenario history with full area, inlet, and parameter restoration;
- status-filtered simulation run history with live progress refresh and result reopening;
- unsaved-change tracking and confirmation before switching scenarios;
- live SSE job status with database frame catch-up after reconnect;
- first-frame display, follow-latest, scrubber, and 700 ms playback;
- depth, stage, speed, and synchronized three-map modes;
- terrain-draped procedural water, with animated flow particles and no independent water/terrain depth mesh;
- double-buffered raster sources with a short cross-fade;
- point sampling of all three quantities;
- formal simulation result routes that survive page reloads.

## Checks

```bash
npm run build
npm test
npm run lint
npx playwright test
```

The Playwright suite uses installed Google Chrome and expects the complete
Compose stack. Its live-playback case submits a real 20-second ANUGA job,
waits for all COGs, reloads the Job deep link, samples a point, and verifies
single/triple display modes.

## Production container

```bash
docker compose up --build web api worker high-resource-worker \
  full-preview-worker celery-beat postgres redis minio titiler
```

Nginx serves the production bundle at <http://localhost:5173> and proxies API
and SSE traffic internally to `api:8000`.
