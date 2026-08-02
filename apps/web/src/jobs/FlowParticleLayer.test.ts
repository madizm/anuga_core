import { describe, expect, it } from 'vitest'
import type { FlowField } from '../api/types'
import { particleSurfaceAltitude, sampleParticleField } from './FlowParticleLayer'

function legacyField(): FlowField {
  return {
    width: 2,
    height: 1,
    bounds: [122, 40, 122.2, 40.1],
    vectors: new Float32Array([1, 2, 3, 4]),
    depths: new Float32Array([0.5, 1.5]),
    texels: null,
  }
}

describe('sampleParticleField', () => {
  it('samples velocity and depth at cell centres', () => {
    const sample = sampleParticleField(legacyField(), 122.05, 40.05)

    expect(sample?.velocity[0]).toBeCloseTo(1)
    expect(sample?.velocity[1]).toBeCloseTo(2)
    expect(sample?.depth).toBeCloseTo(0.5)
    expect(sample?.stage).toBeNull()
  })

  it('rejects dry v3 cells using the depth sentinel', () => {
    const field = legacyField()
    field.depths = null
    field.vectors = new Float32Array([1, 2, 3, 4])
    field.texels = new Uint16Array([
      0x3c00, 0x4000, 0xbc00, 0,
      0x4200, 0x4400, 0x3c00, 0x4900,
    ])

    expect(sampleParticleField(field, 122.05, 40.05)).toBeNull()
    const wet = sampleParticleField(field, 122.15, 40.05)
    expect(wet?.depth).toBe(1)
    expect(wet?.stage).toBe(10)
  })
})

describe('particleSurfaceAltitude', () => {
  it('places particles at stage in flat mode', () => {
    expect(particleSurfaceAltitude({ depth: 2, stage: 12 }, null, 0)).toBeCloseTo(12.08)
  })

  it('exaggerates only the ground component in terrain mode', () => {
    // Ground is stage-depth = 10 m. Depth remains physically 2 m.
    expect(particleSurfaceAltitude({ depth: 2, stage: 12 }, null, 1.5)).toBeCloseTo(17.08)
  })

  it('falls back to queried terrain for legacy fields', () => {
    expect(particleSurfaceAltitude({ depth: 2, stage: null }, 15, 2)).toBeCloseTo(17.08)
  })
})
