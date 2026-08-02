import { MercatorCoordinate } from 'maplibre-gl'
import { describe, expect, it } from 'vitest'
import type { FlowField } from '../api/types'
import {
  buildWaterSurfaceMesh,
  cellSizeMeters,
  crossfadeWeight,
  halfFloatToNumber,
  packFieldPixels,
  sunDirection,
} from './WaterRippleLayer'

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

describe('halfFloatToNumber', () => {
  it('decodes normal, negative, subnormal, and special binary16 values', () => {
    expect(halfFloatToNumber(0x3c00)).toBe(1)
    expect(halfFloatToNumber(0xc000)).toBe(-2)
    expect(halfFloatToNumber(0x0001)).toBeCloseTo(2 ** -24, 12)
    expect(halfFloatToNumber(0x7c00)).toBe(Number.POSITIVE_INFINITY)
    expect(halfFloatToNumber(0x7e00)).toBeNaN()
  })
})

describe('buildWaterSurfaceMesh', () => {
  it('builds indexed geographic triangles rather than a screen-space quad', () => {
    const field = makeField({
      vectors: new Float32Array([1, 1, 1, 1]),
      depths: new Float32Array([0.5, 0.5]),
    })
    const map = {
      queryTerrainElevation: () => 12,
    } as unknown as Parameters<typeof buildWaterSurfaceMesh>[0]

    const mesh = buildWaterSurfaceMesh(map, field, 1.5)

    // A 2×1 field has a 3×2 vertex grid and two geographic quads.
    expect(mesh.vertices).toHaveLength(6 * 5)
    expect(mesh.indices).toHaveLength(2 * 6)
    expect([...mesh.indices]).toEqual([0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4])
    expect(mesh.vertices[3]).toBe(0)
    expect(mesh.vertices[4]).toBe(0)
    expect(mesh.vertices.at(-2)).toBe(1)
    expect(mesh.vertices.at(-1)).toBe(1)
    const first = new MercatorCoordinate(
      mesh.vertices[0], mesh.vertices[1], mesh.vertices[2],
    )
    expect(first.toAltitude()).toBeCloseTo(12.5, 2)
  })

  it('uses a dense Uint32 mesh for large flow fields', () => {
    const width = 300
    const height = 300
    const texels = new Uint16Array(width * height * 4)
    for (let cell = 0; cell < width * height; cell += 1) {
      texels[cell * 4 + 2] = 0x3c00 // depth 1
      texels[cell * 4 + 3] = 0x4900 // stage 10
    }
    const field = makeField({
      width,
      height,
      vectors: new Float32Array(width * height * 2),
      depths: null,
      texels,
    })
    const map = {
      queryTerrainElevation: () => { throw new Error('v3 mesh must use stage') },
    } as unknown as Parameters<typeof buildWaterSurfaceMesh>[0]

    const mesh = buildWaterSurfaceMesh(map, field, 1.5)

    expect(mesh.vertices).toHaveLength(257 * 257 * 5)
    expect(mesh.indices).toBeInstanceOf(Uint32Array)
    expect(mesh.indices).toHaveLength(256 * 256 * 6)
  })
})
