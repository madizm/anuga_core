import { describe, expect, it } from 'vitest'
import type { ScenarioPayload } from '../api/types'
import type { SimulationGrid } from '../map/simulationGrid'
import { buildDensePreviewGrid } from './previewGrid'
import { ReferencePreviewSolver } from './referencePreviewSolver'

function makeGrid(size = 3): SimulationGrid {
  const count = size * size
  return {
    cellCount: count,
    demRows: size,
    demColumns: size,
    rowStart: 0,
    rowStop: size,
    columnStart: 0,
    columnStop: size,
    corners: [[122, 40.03], [122.03, 40.03], [122, 40], [122.03, 40]],
    cellIndices: Uint32Array.from({ length: count }, (_, index) => index),
    elevationM: new Float32Array(count).fill(10),
    buildingFraction: new Float32Array(count),
    buildingDensityClass: new Float32Array(count),
    manningLow: new Float32Array(count).fill(0.03),
    manningMiddle: new Float32Array(count).fill(0.05),
    manningHigh: new Float32Array(count).fill(0.1),
  }
}

function scenario(overrides: Partial<ScenarioPayload> = {}): ScenarioPayload {
  return {
    demProductId: 'dem-test', simulationAreaId: 'a'.repeat(64), name: 'test',
    durationSeconds: 600, yieldstepSeconds: 60, frictionScenario: 'middle',
    inlets: [], rainfall: { enabled: false, points: [] }, hydraulicFeatures: [],
    ...overrides,
  }
}

function solverFor(scenarioValue: ScenarioPayload, size = 3) {
  return new ReferencePreviewSolver(buildDensePreviewGrid(makeGrid(size), scenarioValue, 30))
}

describe('ReferencePreviewSolver', () => {
  it('uses the CFL limit without the former one-second artificial cap', () => {
    const solver = solverFor(scenario())
    expect(solver.recommendedTimeStepSeconds()).toBeCloseTo(10.5)
    for (let cell = 0; cell < 9; cell += 1) solver.grid.initialState[cell * 4] = 9
    solver.reset()
    expect(solver.recommendedTimeStepSeconds()).toBeLessThan(1.2)
  })

  it('keeps flat uniform water still', () => {
    const solver = solverFor(scenario())
    // Remove the tiny inlet source for this static-state assertion and put a
    // uniform one metre state into every active cell.
    for (let cell = 0; cell < solver.grid.width * solver.grid.height; cell += 1) {
      solver.grid.initialState[cell * 4] = 1
    }
    solver.reset()
    for (let step = 0; step < 10; step += 1) solver.step(0.1, 0)
    const snapshot = solver.snapshot(1)
    expect(snapshot.diagnostics.maximumDepthM).toBeCloseTo(1, 6)
    expect(snapshot.diagnostics.maximumSpeedMps).toBeCloseTo(0, 6)
    expect(snapshot.diagnostics.waterVolumeM3).toBeCloseTo(9 * 900, 3)
  })

  it('keeps a constant water surface still over varying terrain', () => {
    const source = makeGrid(3)
    source.elevationM.set([8, 9, 8, 9, 10, 9, 8, 9, 8])
    const solver = new ReferencePreviewSolver(buildDensePreviewGrid(source, scenario(), 30))
    for (let cell = 0; cell < solver.grid.width * solver.grid.height; cell += 1) {
      solver.grid.initialState[cell * 4] = 12 - solver.grid.elevationM[cell]
    }
    solver.reset()
    for (let step = 0; step < 10; step += 1) solver.step(0.1, 0)
    for (let cell = 0; cell < solver.grid.width * solver.grid.height; cell += 1) {
      expect(solver.readState(cell)[0]).toBeCloseTo(12 - solver.grid.elevationM[cell], 6)
      expect(solver.readState(cell)[1]).toBeCloseTo(0, 6)
      expect(solver.readState(cell)[2]).toBeCloseTo(0, 6)
    }
  })

  it('adds rainfall with the declared area and time units', () => {
    const solver = solverFor(scenario(), 2)
    const rain = 0.001
    solver.step(10, rain)
    const snapshot = solver.snapshot(10)
    expect(snapshot.diagnostics.waterVolumeM3).toBeCloseTo(rain * 4 * 900 * 10, 2)
    expect(snapshot.diagnostics.appliedInputVolumeM3).toBeCloseTo(rain * 4 * 900 * 10, 2)
  })

  it('keeps a 24-hour CFL-adaptive rainfall run finite and mass balanced', () => {
    const solver = solverFor(scenario({ durationSeconds: 86_400 }), 2)
    const rainfallRateMps = 0.001 / 3_600
    let timeSeconds = 0
    while (timeSeconds < 86_400) {
      const dt = Math.min(solver.recommendedTimeStepSeconds(), 86_400 - timeSeconds)
      solver.step(dt, rainfallRateMps)
      timeSeconds += dt
    }
    const diagnostics = solver.snapshot(timeSeconds).diagnostics
    expect(diagnostics.maximumDepthM).toBeCloseTo(0.024, 4)
    expect(diagnostics.massResidualM3).toBeCloseTo(0, 2)
    expect(Number.isFinite(diagnostics.maximumSpeedMps)).toBe(true)
  })

  it('blocks below-crest flow across a rasterized levee face', () => {
    const solver = solverFor(scenario({
      hydraulicFeatures: [{
        id: 'levee-1', name: '堤防', enabled: true, type: 'levee',
        geometry: { type: 'LineString', coordinates: [[122.01, 40], [122.01, 40.03]] },
        crestMode: 'absolute', crestElevationM: 12, qFactor: 1,
      }],
    }))
    for (let y = 0; y < solver.grid.height; y += 1) solver.grid.initialState[(y * 3) * 4] = 1
    solver.reset()
    solver.step(0.1, 0)
    for (let y = 0; y < solver.grid.height; y += 1) {
      expect(solver.readState(y * 3 + 1)[0]).toBeCloseTo(0, 8)
    }
  })

  it('limits a drainage outlet by its declared capacity', () => {
    const solver = solverFor(scenario({
      hydraulicFeatures: [{
        id: 'outlet-1', name: '排水口', enabled: true, type: 'drainageOutlet',
        geometry: { type: 'Point', coordinates: [122.015, 40.015] },
        capacityM3s: 9, intakeRadiusM: 1, fullCapacityDepthM: 0.3, blockage: 0,
      }],
    }))
    for (let cell = 0; cell < 9; cell += 1) solver.grid.initialState[cell * 4] = 1
    solver.reset()
    solver.step(1, 0)
    const snapshot = solver.snapshot(1)
    expect(snapshot.diagnostics.structureOutflowM3).toBeCloseTo(9, 6)
    expect(snapshot.diagnostics.waterVolumeM3).toBeCloseTo(9 * 900 - 9, 4)
  })

  it('keeps all states finite and non-negative after a dam-break-like pulse', () => {
    const solver = solverFor(scenario({
      inlets: [{
        id: 'inlet', name: 'dam', enabled: true, cellIds: ['r0001-c0000'],
        dischargeM3s: 100, velocityMode: 'components', velocityUMps: 3,
        velocityVMps: 0, initialWaterLevelM: 14, displayColor: '#00e5ff',
      }],
    }), 5)
    const initial = solver.snapshot(0)
    expect([...initial.field.texels!].some((value) => value === 0xbc00)).toBe(true)
    for (let step = 0; step < 30; step += 1) {
      solver.step(Math.min(0.2, solver.recommendedTimeStepSeconds()), 0)
    }
    const snapshot = solver.snapshot(6)
    expect(snapshot.diagnostics.maximumDepthM).toBeGreaterThan(0)
    expect(snapshot.diagnostics.maximumSpeedMps).toBeGreaterThanOrEqual(0)
    expect([...snapshot.field.vectors].every(Number.isFinite)).toBe(true)
    expect([...snapshot.field.texels!].every(Number.isFinite)).toBe(true)
  })
})
