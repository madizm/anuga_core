import { describe, expect, it } from 'vitest'
import type { FlowField } from '../api/types'
import {
  cellSizeMeters,
  crossfadeWeight,
  packFieldPixels,
  sunDirection,
  waterSurfaceEffects,
  waterCanvasCoordinates,
  waterCanvasSize,
} from './TerrainDrapedWaterLayer'

function makeField(overrides: Partial<FlowField> = {}): FlowField {
  return {
    width: 2,
    height: 1,
    bounds: [122.1, 40.1, 122.2, 40.2],
    corners: null,
    vectors: new Float32Array([Number.NaN, Number.NaN, 3, 4]),
    depths: new Float32Array([Number.NaN, 0.5]),
    texels: null,
    ...overrides,
  }
}

describe('packFieldPixels', () => {
  it('packs wet cells as (u, v, depth, 1) and zeroes dry cells', () => {
    const pixels = packFieldPixels(makeField())

    expect([...pixels.slice(0, 4)]).toEqual([0, 0, 0, 0])
    expect([...pixels.slice(4, 8)]).toEqual([3, 4, 0.5, 1])
  })

  it('treats cells with finite velocity but NaN depth as dry in v2', () => {
    const pixels = packFieldPixels(makeField({
      vectors: new Float32Array([1, 2, 3, 4]),
      depths: new Float32Array([Number.NaN, 0.5]),
    }))

    expect([...pixels.slice(0, 4)]).toEqual([0, 0, 0, 0])
    expect(pixels[7]).toBe(1)
  })

  it('falls back to depth 1 for legacy v1 fields without a depth plane', () => {
    const pixels = packFieldPixels(makeField({ depths: null }))

    expect([...pixels.slice(0, 4)]).toEqual([0, 0, 0, 0])
    expect([...pixels.slice(4, 8)]).toEqual([3, 4, 1, 1])
  })
})

describe('cellSizeMeters', () => {
  it('derives metres per cell from the geographic bounds', () => {
    const field = makeField({
      width: 10,
      height: 10,
      bounds: [122.0, 40.0, 122.1, 40.1],
    })
    const [x, y] = cellSizeMeters(field)

    const expectedX = 0.1 * 111_320 * Math.cos(40.05 * Math.PI / 180) / 10
    expect(x).toBeCloseTo(expectedX, 6)
    expect(y).toBeCloseTo(0.1 * 110_540 / 10, 6)
  })
})

describe('sunDirection', () => {
  it('points north at azimuth 0', () => {
    const [x, y, z] = sunDirection(0, 30)
    expect(x).toBeCloseTo(0, 6)
    expect(y).toBeCloseTo(Math.cos(30 * Math.PI / 180), 6)
    expect(z).toBeCloseTo(0.5, 6)
  })

  it('points northwest at azimuth 325 (hillshade convention)', () => {
    const [x, y] = sunDirection(325, 50)
    expect(x).toBeLessThan(0)
    expect(y).toBeGreaterThan(0)
  })

  it('returns unit vectors', () => {
    const [x, y, z] = sunDirection(217, 63)
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6)
  })
})

describe('crossfadeWeight', () => {
  it('ramps linearly over the crossfade window', () => {
    expect(crossfadeWeight(0, false)).toBe(0)
    expect(crossfadeWeight(110, false)).toBeCloseTo(0.5, 6)
    expect(crossfadeWeight(220, false)).toBe(1)
    expect(crossfadeWeight(10_000, false)).toBe(1)
  })

  it('snaps to done under reduced motion', () => {
    expect(crossfadeWeight(0, true)).toBe(1)
  })
})

describe('waterSurfaceEffects', () => {
  it('removes wave relief and highlights from static water', () => {
    expect(waterSurfaceEffects(false)).toEqual({
      amplitude: 0, specular: 0, sheen: 0, sparkle: 0,
    })
    expect(waterSurfaceEffects(true).amplitude).toBeGreaterThan(0)
  })
})

describe('terrain-draped canvas placement', () => {
  it('orders bounds clockwise from northwest for MapLibre CanvasSource', () => {
    expect(waterCanvasCoordinates(makeField())).toEqual([
      [122.1, 40.2],
      [122.2, 40.2],
      [122.2, 40.1],
      [122.1, 40.1],
    ])
  })

  it('preserves the exact projected grid footprint', () => {
    const corners: FlowField['corners'] = [
      [1, 4], [3, 5], [0, 1], [2, 2],
    ]

    expect(waterCanvasCoordinates(makeField({ corners }))).toEqual([
      corners[0], corners[1], corners[3], corners[2],
    ])
  })

  it('uses four pixels per field cell while bounding texture uploads', () => {
    expect(waterCanvasSize({ width: 124, height: 104 })).toEqual([496, 416])
    expect(waterCanvasSize({ width: 300, height: 150 })).toEqual([512, 256])
  })
})
