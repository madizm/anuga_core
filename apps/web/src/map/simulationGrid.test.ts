import { describe, expect, test } from 'vitest'
import {
  cellAtLngLat,
  cellBounds,
  gridBoundaryLngLat,
  gridUvToLngLat,
  lngLatToGridUv,
  parseSimulationGrid,
  type SimulationGrid,
} from './simulationGrid'

function binaryGrid(): ArrayBuffer {
  const count = 2
  const buffer = new ArrayBuffer(100 + count * 7 * 4)
  const view = new DataView(buffer)
  for (const [index, value] of [...'BQSG'].entries()) view.setUint8(index, value.charCodeAt(0))
  view.setUint16(4, 1, true)
  view.setUint16(6, 100, true)
  view.setUint32(8, count, true)
  view.setUint32(12, 100, true)
  view.setUint32(16, 200, true)
  view.setUint32(20, 10, true)
  view.setUint32(24, 12, true)
  view.setUint32(28, 20, true)
  view.setUint32(32, 22, true)
  const corners = [122, 40.02, 122.02, 40.021, 122.001, 40, 122.021, 40.001]
  corners.forEach((value, index) => view.setFloat64(36 + index * 8, value, true))
  new Uint32Array(buffer, 100, count).set([2020, 2221])
  for (let plane = 1; plane < 7; plane += 1) {
    new Float32Array(buffer, 100 + plane * count * 4, count).set([plane, plane + 0.5])
  }
  return buffer
}

function grid(): SimulationGrid {
  return parseSimulationGrid(binaryGrid())
}

describe('compact simulation grid', () => {
  test('parses typed planes without GeoJSON expansion', () => {
    const parsed = grid()
    expect(parsed.cellCount).toBe(2)
    expect([...parsed.cellIndices]).toEqual([2020, 2221])
    expect([...parsed.elevationM]).toEqual([1, 1.5])
    expect([...parsed.manningHigh]).toEqual([6, 6.5])
  })

  test('rejects truncated and unordered payloads', () => {
    expect(() => parseSimulationGrid(binaryGrid().slice(0, -1))).toThrow('不完整')
    const invalid = binaryGrid()
    new Uint32Array(invalid, 100, 2).set([2221, 2020])
    expect(() => parseSimulationGrid(invalid)).toThrow('索引无效')
  })

  test('inverts the skewed four-corner mapping', () => {
    const parsed = grid()
    const point = gridUvToLngLat(parsed, 0.37, 0.64)
    const uv = lngLatToGridUv(parsed, ...point)
    expect(uv?.[0]).toBeCloseTo(0.37, 10)
    expect(uv?.[1]).toBeCloseTo(0.64, 10)
  })

  test('maps geographic positions only to selected cells', () => {
    const parsed = grid()
    expect(cellAtLngLat(parsed, ...gridBoundaryLngLat(parsed, 10.5, 20.5))).toBe('r0010-c0020')
    expect(cellAtLngLat(parsed, ...gridBoundaryLngLat(parsed, 10.5, 21.5))).toBeNull()
    expect(cellAtLngLat(parsed, ...gridBoundaryLngLat(parsed, 11.5, 21.5))).toBe('r0011-c0021')
  })

  test('derives locate bounds from cell IDs', () => {
    const bounds = cellBounds(grid(), ['r0010-c0020', 'r0011-c0021'])
    expect(bounds?.[0][0]).toBeCloseTo(122)
    expect(bounds?.[1][0]).toBeCloseTo(122.021)
    expect(bounds?.[0][1]).toBeCloseTo(40)
    expect(bounds?.[1][1]).toBeCloseTo(40.021)
  })
})
