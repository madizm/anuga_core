import { describe, expect, test } from 'vitest'
import {
  cellAtLngLat,
  cellBounds,
  gridBoundaryLngLat,
  gridUvToLngLat,
  lngLatToGridUv,
  type SimulationGrid,
} from './simulationGrid'

function grid(): SimulationGrid {
  return {
    cellCount: 2,
    demRows: 100,
    demColumns: 200,
    rowStart: 10,
    rowStop: 12,
    columnStart: 20,
    columnStop: 22,
    corners: [[122, 40.02], [122.02, 40.021], [122.001, 40], [122.021, 40.001]],
    cellIndices: new Uint32Array([2020, 2221]),
    elevationM: new Float32Array([1, 1.5]),
    buildingFraction: new Float32Array(2),
    buildingDensityClass: new Float32Array(2),
    manningLow: new Float32Array([0.03, 0.03]),
    manningMiddle: new Float32Array([0.05, 0.05]),
    manningHigh: new Float32Array([0.1, 0.1]),
  }
}

describe('simulation grid coordinates', () => {
  test('inverts the skewed four-corner mapping', () => {
    const source = grid()
    const point = gridUvToLngLat(source, 0.37, 0.64)
    const uv = lngLatToGridUv(source, ...point)
    expect(uv?.[0]).toBeCloseTo(0.37, 10)
    expect(uv?.[1]).toBeCloseTo(0.64, 10)
  })

  test('maps geographic positions only to selected cells', () => {
    const source = grid()
    expect(cellAtLngLat(source, ...gridBoundaryLngLat(source, 10.5, 20.5))).toBe('r0010-c0020')
    expect(cellAtLngLat(source, ...gridBoundaryLngLat(source, 10.5, 21.5))).toBeNull()
    expect(cellAtLngLat(source, ...gridBoundaryLngLat(source, 11.5, 21.5))).toBe('r0011-c0021')
  })

  test('derives locate bounds from cell IDs', () => {
    const bounds = cellBounds(grid(), ['r0010-c0020', 'r0011-c0021'])
    expect(bounds?.[0][0]).toBeCloseTo(122)
    expect(bounds?.[1][0]).toBeCloseTo(122.021)
    expect(bounds?.[0][1]).toBeCloseTo(40)
    expect(bounds?.[1][1]).toBeCloseTo(40.021)
  })
})
