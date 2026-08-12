import { existsSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const requestedCells = Number(process.env.PREVIEW_BENCHMARK_CELLS ?? 1_048_576)
const width = Math.floor(Math.sqrt(requestedCells))
const height = Math.ceil(requestedCells / width)
const cellCount = width * height
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const executablePath = process.env.CHROME_PATH
  ?? (existsSync(systemChrome) ? systemChrome : undefined)

const server = await createServer({
  configFile: new URL('../vite.config.ts', import.meta.url).pathname,
  plugins: [{
    name: 'static-preview-benchmark-page',
    configureServer(vite) {
      vite.middlewares.use('/__preview-benchmark__', (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end('<!doctype html><title>Static preview benchmark</title>')
      })
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
})
await server.listen()
const baseUrl = server.resolvedUrls?.local[0]
if (!baseUrl) throw new Error('Vite benchmark server did not publish a local URL')
const browser = await chromium.launch({ headless: true, executablePath })
try {
  const page = await browser.newPage()
  // Establish the Vite origin without booting the application and consuming
  // extra WebGL contexts; the benchmark imports only the solver module.
  await page.goto(new URL('__preview-benchmark__', baseUrl).href)
  const result = await page.evaluate(async ({ width, height }) => {
    const { WebGL2PreviewSolver } = await import('/src/preview/webgl2PreviewSolver.ts')
    const cells = width * height
    const mark = () => performance.now()
    const started = mark()
    const mask = new Float32Array(cells)
    mask.fill(1)
    const elevationM = new Float32Array(cells)
    const manningN = new Float32Array(cells)
    manningN.fill(0.05)
    const initialState = new Float32Array(cells * 4)
    for (let cell = 0; cell < cells; cell += 1) initialState[cell * 4 + 3] = 1
    const faceXCount = (width + 1) * height
    const faceYCount = width * (height + 1)
    const crestX = new Float32Array(faceXCount)
    const crestY = new Float32Array(faceYCount)
    const qFactorX = new Float32Array(faceXCount)
    const qFactorY = new Float32Array(faceYCount)
    crestX.fill(Number.NaN)
    crestY.fill(Number.NaN)
    qFactorX.fill(1)
    qFactorY.fill(1)
    const grid = {
      width, height, cellSizeM: 30,
      corners: [[122, 40], [123, 40], [122, 39], [123, 39]],
      mask, elevationM, manningN,
      inletDepthRateMps: new Float32Array(cells),
      inletXMomentumRate: new Float32Array(cells),
      inletYMomentumRate: new Float32Array(cells),
      initialState,
      activeCellCount: cells,
      activeAreaM2: cells * 900,
      initialWaterVolumeM3: 0,
      inletDischargeM3s: 0,
      hydraulics: {
        bedElevationM: new Float32Array(elevationM),
        manningN: new Float32Array(manningN),
        sourceDepthRateMps: new Float32Array(cells),
        outletCapacityM3s: new Float32Array(cells),
        outletFullCapacityDepthM: new Float32Array(cells),
        outletBlockage: new Float32Array(cells),
        wallX: new Float32Array(faceXCount), wallY: new Float32Array(faceYCount),
        crestX, crestY, qFactorX, qFactorY,
        links: [], approximatedFeatures: [], unsupportedFeatures: [],
      },
    }
    const arraysReady = mark()
    const solver = new WebGL2PreviewSolver(grid)
    const initialized = mark()
    let simulatedSeconds = 0
    const steps = 3
    for (let index = 0; index < steps; index += 1) {
      const dt = solver.recommendedTimeStepSeconds()
      solver.step(dt, 0.000001)
      simulatedSeconds += dt
    }
    const stepped = mark()
    const snapshot = solver.snapshot(simulatedSeconds)
    const snapped = mark()
    const memory = performance.memory
      ? {
          usedJSHeapBytes: performance.memory.usedJSHeapSize,
          totalJSHeapBytes: performance.memory.totalJSHeapSize,
        }
      : null
    const diagnostics = snapshot.diagnostics
    solver.dispose()
    return {
      cells, width, height, steps, simulatedSeconds,
      timingsMs: {
        allocateGrid: arraysReady - started,
        initializeSolver: initialized - arraysReady,
        solveAndReduce: stepped - initialized,
        fullSnapshot: snapped - stepped,
        total: snapped - started,
      },
      diagnostics: {
        wetCellCount: diagnostics.wetCellCount,
        maximumDepthM: diagnostics.maximumDepthM,
        massResidualM3: diagnostics.massResidualM3,
      },
      memory,
    }
  }, { width, height })
  console.log(JSON.stringify(result, null, 2))
  if (result.cells < 1_000_000 && requestedCells >= 1_000_000) {
    throw new Error(`Benchmark constructed only ${result.cells} cells`)
  }
  if (!Number.isFinite(result.timingsMs.total) || result.timingsMs.total <= 0) {
    throw new Error('Benchmark did not produce valid timings')
  }
} finally {
  await browser.close()
  await server.close()
}
