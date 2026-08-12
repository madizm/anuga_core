import { describe, expect, it } from 'vitest'
import type { ScenarioPayload } from '../api/types'
import type { SimulationGrid } from '../map/simulationGrid'
import { buildDensePreviewGrid, validatePreviewGridSize } from './previewGrid'

function grid(): SimulationGrid {
  return {
    cellCount: 4,
    demRows: 2,
    demColumns: 2,
    rowStart: 0,
    rowStop: 2,
    columnStart: 0,
    columnStop: 2,
    corners: [[122, 40.02], [122.02, 40.02], [122, 40], [122.02, 40]],
    cellIndices: new Uint32Array([0, 1, 2, 3]),
    elevationM: new Float32Array([10, 11, 12, 13]),
    buildingFraction: new Float32Array(4),
    buildingDensityClass: new Float32Array(4),
    manningLow: new Float32Array([0.03, 0.03, 0.03, 0.03]),
    manningMiddle: new Float32Array([0.05, 0.05, 0.05, 0.05]),
    manningHigh: new Float32Array([0.1, 0.1, 0.1, 0.1]),
  }
}

function scenario(overrides: Partial<ScenarioPayload> = {}): ScenarioPayload {
  return {
    demProductId: 'dem-test',
    simulationAreaId: 'a'.repeat(64),
    name: 'preview test',
    durationSeconds: 600,
    yieldstepSeconds: 60,
    frictionScenario: 'middle',
    inlets: [],
    rainfall: { enabled: false, points: [] },
    hydraulicFeatures: [],
    ...overrides,
  }
}

describe('buildDensePreviewGrid', () => {
  it('stores the north row at the top of display snapshots and the south row at GPU y=0', () => {
    const result = buildDensePreviewGrid(grid(), scenario(), 30)
    expect([...result.elevationM]).toEqual([12, 13, 10, 11])
    expect([...result.mask]).toEqual([1, 1, 1, 1])
  })

  it('attaches the compiled hydraulic model to the dense solver grid', () => {
    const result = buildDensePreviewGrid(grid(), scenario({
      hydraulicFeatures: [{
        id: 'channel-1', name: '河道', enabled: true, type: 'simpleChannel',
        geometry: {
          type: 'Polygon',
          coordinates: [[[122, 40.02], [122.02, 40.02], [122.02, 40], [122, 40], [122, 40.02]]],
        },
        elevationMode: 'lowerBy', depthM: 1, manningN: 0.03, maxTriangleAreaM2: 10,
      }],
    }), 30)
    expect(result.hydraulics?.bedElevationM[0]).toBeCloseTo(11)
    expect(result.hydraulics?.manningN[0]).toBeCloseTo(0.03)
  })

  it('converts inlet discharge and bearing into per-cell source terms', () => {
    const result = buildDensePreviewGrid(grid(), scenario({
      inlets: [{
        id: 'inlet-001', name: '入口', enabled: true, cellIds: ['r0000-c0000', 'r0000-c0001'],
        dischargeM3s: 90, velocityMode: 'bearing', speedMps: 2, bearingDegrees: 90,
        initialWaterLevelM: 15, displayColor: '#00e5ff',
      }],
    }), 30)
    // north row is GPU y=1, so its cells occupy indices 2 and 3.
    expect(result.inletDepthRateMps[2]).toBeCloseTo(90 / (2 * 900))
    expect(result.inletXMomentumRate[2]).toBeCloseTo(90 / (2 * 900) * 2)
    expect(result.inletYMomentumRate[2]).toBeCloseTo(0)
    expect(result.initialState[2 * 4]).toBeCloseTo(5)
    expect(result.initialWaterVolumeM3).toBeCloseTo(5 * 900 + 4 * 900)
  })

  it('marks enclosed inactive cells as solid holes and edge gaps as open exterior', () => {
    const input = grid()
    input.cellCount = 8
    input.rowStart = 0
    input.rowStop = 3
    input.columnStart = 0
    input.columnStop = 3
    input.demRows = 3
    input.demColumns = 3
    input.cellIndices = new Uint32Array([0, 1, 2, 3, 5, 6, 7, 8])
    input.elevationM = new Float32Array(8).fill(10)
    input.manningLow = new Float32Array(8).fill(0.03)
    input.manningMiddle = new Float32Array(8).fill(0.05)
    input.manningHigh = new Float32Array(8).fill(0.1)
    const result = buildDensePreviewGrid(input, scenario(), 30)
    // The missing centre is enclosed by the eight active cells.
    expect([...result.mask].filter((value) => value === -1)).toHaveLength(1)
  })

  it('rejects oversized dense bounds before allocating grid arrays', () => {
    const input = grid()
    input.cellCount = 1
    input.demRows = 2_000_000
    input.demColumns = 2_000_000
    input.rowStop = 2_000_000
    input.columnStop = 2_000_000
    input.cellIndices = new Uint32Array([0])
    input.elevationM = new Float32Array([10])
    input.manningLow = new Float32Array([0.03])
    input.manningMiddle = new Float32Array([0.05])
    input.manningHigh = new Float32Array([0.1])
    expect(() => buildDensePreviewGrid(input, scenario(), 30, {
      mode: 'static', maxTextureSize: 16_384,
    })).toThrow(/纹理上限/)
    expect(() => buildDensePreviewGrid(input, scenario(), 30)).toThrow(/内存上限/)
  })
  it('applies separate dense-grid limits to animated and static preview modes', () => {
    expect(validatePreviewGridSize(512, 512, { mode: 'animated' })).toBe(262_144)
    expect(() => validatePreviewGridSize(513, 512, { mode: 'animated' })).toThrow(/动态预览/)
    expect(validatePreviewGridSize(1_024, 1_024, { mode: 'static' })).toBe(1_048_576)
    expect(() => validatePreviewGridSize(1_025, 1_024, { mode: 'static' })).toThrow(/静态快照预览/)
  })

})
