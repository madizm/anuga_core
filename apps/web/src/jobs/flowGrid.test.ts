import { describe, expect, it } from 'vitest'
import type { FlowField } from '../api/types'
import { advectGridPosition, gridUvToLngLat, lngLatToGridUv } from './flowGrid'

const reference: Pick<FlowField, 'bounds' | 'corners'> = {
  bounds: [122.1, 40.099, 122.201, 40.2],
  corners: [
    [122.1, 40.2],
    [122.2, 40.199],
    [122.101, 40.1],
    [122.201, 40.099],
  ],
}

describe('flow grid georeferencing', () => {
  it('maps raster corners without expanding them to the geographic envelope', () => {
    expect(gridUvToLngLat(reference, 0, 0)).toEqual([122.1, 40.2])
    expect(gridUvToLngLat(reference, 1, 0)).toEqual([122.2, 40.199])
    expect(gridUvToLngLat(reference, 0, 1)).toEqual([122.101, 40.1])
    expect(gridUvToLngLat(reference, 1, 1)).toEqual([122.201, 40.099])
  })

  it('round-trips positions through the inverse bilinear mapping', () => {
    for (const expected of [[0.1, 0.2], [0.5, 0.5], [0.9, 0.8]] as const) {
      const position = gridUvToLngLat(reference, expected[0], expected[1])
      const actual = lngLatToGridUv(reference, ...position)
      expect(actual[0]).toBeCloseTo(expected[0], 10)
      expect(actual[1]).toBeCloseTo(expected[1], 10)
    }
  })

  it('advects projected velocity along the rotated grid axes', () => {
    const start = gridUvToLngLat(reference, 0.5, 0.5)
    const end = advectGridPosition(reference, ...start, [100, 0], 1)
    const [u, v] = lngLatToGridUv(reference, ...end)

    expect(u).toBeGreaterThan(0.5)
    expect(v).toBeCloseTo(0.5, 10)
  })

  it('preserves legacy axis-aligned fields', () => {
    const legacy = { bounds: [122, 40, 123, 41] as [number, number, number, number], corners: null }
    expect(gridUvToLngLat(legacy, 0.25, 0.75)).toEqual([122.25, 40.25])
    expect(lngLatToGridUv(legacy, 122.25, 40.25)).toEqual([0.25, 0.75])
  })
})
