import { describe, expect, it } from 'vitest'
import type { ScenarioPayload } from '../api/types'
import { previewCompatibility, rainfallRateMps } from './previewScenario'

const base: ScenarioPayload = {
  demProductId: 'dem', simulationAreaId: 'a'.repeat(64), name: 'preview',
  durationSeconds: 600, yieldstepSeconds: 60, frictionScenario: 'middle',
  inlets: [], rainfall: { enabled: false, points: [] }, hydraulicFeatures: [],
}

describe('preview scenario contract', () => {
  it('uses the step rain profile with mm/h to m/s conversion', () => {
    const rainfall = {
      enabled: true,
      points: [{ timeMinutes: 0, intensityMmPerHour: 36 }, { timeMinutes: 5, intensityMmPerHour: 72 }],
    }
    expect(rainfallRateMps(rainfall, 299)).toBeCloseTo(36 / 1000 / 3600)
    expect(rainfallRateMps(rainfall, 300)).toBeCloseTo(72 / 1000 / 3600)
  })

  it('reports enabled hydraulic features instead of silently dropping them', () => {
    const result = previewCompatibility({
      ...base,
      hydraulicFeatures: [{
        id: 'bridge-1', name: '桥梁 1', enabled: true, type: 'bridge',
        geometry: { type: 'LineString', coordinates: [[122, 40], [122.01, 40.01]] },
        widthM: 8, heightM: 3, leftSideSlope: 1, rightSideSlope: 1,
        blockage: 0, losses: 1, manningN: 0.03,
      }],
    })
    expect(result.supported).toBe(false)
    expect(result.messages).toEqual(['桥梁 1（桥梁）'])
  })

  it('marks rasterized hydraulic features as approximate but previewable', () => {
    const result = previewCompatibility({
      ...base,
      hydraulicFeatures: [{
        id: 'levee-1', name: '堤防 1', enabled: true, type: 'levee',
        geometry: { type: 'LineString', coordinates: [[122, 40], [122.01, 40.01]] },
        crestMode: 'relative', heightAboveGroundM: 2, qFactor: 1,
      }],
    })
    expect(result.supported).toBe(true)
    expect(result.approximationMessages).toEqual(['堤防 1（堤防）'])
    expect(result.messages).toEqual([])
  })

  it('allows a clean rainfall/inlet preview contract', () => {
    expect(previewCompatibility(base)).toMatchObject({ supported: true, messages: [] })
  })
})
