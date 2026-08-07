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
  it('keeps flat uniform water still', () => {
    const solver = solverFor(scenario())
    // Remove the tiny inlet source for this static-state assertion and put a
    // uniform one metre state into every active cell.
    for (let cell = 0; cell < solver.grid.width * solver.grid.height; cell += 1) {
      solver.grid.initialState[cell * 4] = 1
    }
    solver.reset()
    solver.step(0.1, 0)
    const snapshot = solver.snapshot(0.1)
    expect(snapshot.diagnostics.maximumDepthM).toBeLessThanOrEqual(1)
    expect(snapshot.diagnostics.maximumSpeedMps).toBeLessThan(0.1)
    expect(snapshot.diagnostics.waterVolumeM3).toBeLessThanOrEqual(9 * 900)
  })

  it('adds rainfall with the declared area and time units', () => {
    const solver = solverFor(scenario(), 2)
    const rain = 0.001
    solver.step(10, rain)
    const snapshot = solver.snapshot(10)
    expect(snapshot.diagnostics.waterVolumeM3).toBeCloseTo(rain * 4 * 900 * 10, 2)
    expect(snapshot.diagnostics.appliedInputVolumeM3).toBeCloseTo(rain * 4 * 900 * 10, 2)
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
