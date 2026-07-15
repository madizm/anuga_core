# Bayuquan Web GIS editor

A React, TypeScript, and MapLibre implementation of the phase-D inlet editor.
The visual direction is a dense hydrodynamic operations console: graphite map,
cyan inlet controls, explicit engineering units, and high-contrast risk states.

## Development

Start the API stack, then Vite:

```bash
docker compose up -d postgres redis minio api worker
cd apps/web
npm install
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` to port 8000.

## Supported editor interactions

- single-cell toggle;
- Shift-add and Alt-remove;
- continuous brush selection;
- rectangular selection;
- multiple independently colored inlets;
- overlap prevention and four-neighbour connectivity status;
- discharge, velocity components/bearing, and initial water level;
- server-resolved triangle, hydraulic-area, elevation, and Manning statistics;
- transactional scenario save, validation, warning confirmation, and Job submit.
- live SSE job status with database frame catch-up after reconnect;
- first-frame display, follow-latest, scrubber, and 700 ms playback;
- depth, stage, speed, and synchronized three-map modes;
- double-buffered raster sources with a short cross-fade;
- point sampling of all three quantities;
- Job deep links (`?job=<uuid>`) that survive page reloads.

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
docker compose up --build web api worker postgres redis minio titiler
```

Nginx serves the production bundle at <http://localhost:5173> and proxies API
and SSE traffic internally to `api:8000`.
