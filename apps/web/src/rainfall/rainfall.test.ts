import { describe, expect, it } from 'vitest'
import { hasEffectiveRainfall, rainfallSummary, rainfallValidationError } from './rainfall'

const profile = {
  enabled: true,
  points: [
    { timeMinutes: 0, intensityMmPerHour: 0 },
    { timeMinutes: 10, intensityMmPerHour: 30 },
    { timeMinutes: 40, intensityMmPerHour: 10 },
  ],
}

describe('rainfall profile', () => {
  it('integrates right-continuous steps through simulation end', () => {
    expect(rainfallSummary(profile, 3600)).toEqual({
      cumulativeDepthMm: 55 / 3,
      peakIntensityMmPerHour: 30,
      pointCount: 3,
    })
  })

  it('accepts one point as constant rainfall', () => {
    const constant = {
      enabled: true,
      points: [{ timeMinutes: 0, intensityMmPerHour: 50 }],
    }
    expect(rainfallSummary(constant, 3600).cumulativeDepthMm).toBe(50)
    expect(hasEffectiveRainfall(constant, 3600)).toBe(true)
  })

  it('strictly validates enabled profiles but ignores disabled drafts', () => {
    expect(rainfallValidationError({
      enabled: true,
      points: [{ timeMinutes: 1, intensityMmPerHour: 50 }],
    }, 3600)).toContain('0 分钟')
    expect(rainfallValidationError({
      enabled: false,
      points: [{ timeMinutes: 99, intensityMmPerHour: -1 }],
    }, 60)).toBeNull()
  })
})
