# Static snapshot preview benchmark

## Reproduce

```bash
cd apps/web
npm run benchmark:preview
```

The harness starts an isolated Vite page, constructs a dense 1024×1024 grid,
allocates the real `WebGL2PreviewSolver`, executes three solver steps including
GPU maximum-wave-speed reductions, creates one complete CPU snapshot, and then
releases the WebGL resources. Set `PREVIEW_BENCHMARK_CELLS` to exercise another
cell count.

## Baseline — 2026-08-12

Hardware and browser:

- Apple M1 Pro, Metal 4;
- macOS arm64 (Darwin 25.6.0);
- Google Chrome 151.0.7922.138, headless;
- 1,048,576 cells (1024×1024), 30 m cell size.

Observed result:

| Operation | Time |
| --- | ---: |
| Allocate CPU grid and hydraulic planes | 9.0 ms |
| Initialize solver and GPU resources | 171.4 ms |
| Three solver steps plus GPU reductions | 53.2 ms |
| Complete GPU readback and snapshot encoding | 54.6 ms |
| Total | 288.2 ms |

Chrome reported approximately 163 MB used JS heap at the snapshot. Three dry-to-
shallow-rainfall steps simulated 31.5 seconds. The mass residual was 0.000236 m³
across the 943,718,400 m² synthetic domain.

These numbers are a reproducible engineering baseline, not a duration promise:
terrain complexity, wet-cell velocities, thermal state, browser/driver version,
and hydraulic features affect throughput. Product startup therefore retains a
real 1024×1024 floating-texture allocation probe and reports allocation failure
instead of relying only on nominal GPU memory.
