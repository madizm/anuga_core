import { describe, expect, it } from 'vitest'
import type { SimulationFrame } from '../api/types'
import { mergeFrames } from './useJobPlayback'

function frame(frameIndex: number): SimulationFrame {
  return {
    jobId: 'job-a',
    frameIndex,
    timeSeconds: frameIndex * 10,
    maximumDepthM: frameIndex,
    maximumSpeedMps: frameIndex,
    wetAreaM2: frameIndex * 900,
    tilejson: { depth: '/depth', stage: '/stage', speed: '/speed' },
    createdAt: '2026-01-01T00:00:00Z',
  }
}

describe('mergeFrames', () => {
  it('deduplicates replayed SSE frames and maintains timeline order', () => {
    expect(mergeFrames([frame(1)], [frame(2), frame(0), frame(1)]).map(
      (item) => item.frameIndex,
    )).toEqual([0, 1, 2])
  })

  it('replaces an existing frame with the database authority copy', () => {
    const authoritative = { ...frame(1), maximumDepthM: 4.2 }
    expect(mergeFrames([frame(1)], [authoritative])[0]).toEqual(authoritative)
  })
})
