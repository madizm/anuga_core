// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { ScenarioPayload } from '../api/types'
import type { DensePreviewGrid, PreviewSolver } from './types'
import { PreviewController } from './PreviewController'

function grid(): DensePreviewGrid {
  return {
    width: 1,
    height: 1,
    cellSizeM: 30,
    corners: [[122, 40], [122.01, 40], [122, 39.99], [122.01, 39.99]],
    mask: new Float32Array([1]),
    elevationM: new Float32Array([10]),
    manningN: new Float32Array([0.05]),
    inletDepthRateMps: new Float32Array(1),
    inletXMomentumRate: new Float32Array(1),
    inletYMomentumRate: new Float32Array(1),
    initialState: new Float32Array(4),
    activeCellCount: 1,
    activeAreaM2: 900,
    initialWaterVolumeM3: 0,
    inletDischargeM3s: 0,
  }
}

function scenario(): ScenarioPayload {
  return {
    demProductId: 'dem', simulationAreaId: 'area', name: 'preview',
    durationSeconds: 60, yieldstepSeconds: 10, frictionScenario: 'middle',
    inlets: [], rainfall: { enabled: false, points: [] }, hydraulicFeatures: [],
  }
}

function solver(input: DensePreviewGrid): PreviewSolver & { reset: ReturnType<typeof vi.fn> } {
  return {
    grid: input,
    reset: vi.fn(),
    recommendedTimeStepSeconds: () => 1,
    step: vi.fn(),
    snapshot: (timeSeconds) => ({
      timeSeconds,
      field: {
        width: 1, height: 1, bounds: [122, 39.99, 122.01, 40],
        corners: input.corners.map((corner) => [...corner]) as [
          [number, number], [number, number], [number, number], [number, number],
        ],
        vectors: new Float32Array(2), depths: new Float32Array(1),
        texels: null,
      },
      diagnostics: {
        timeStepSeconds: 1, waterVolumeM3: 0, appliedInputVolumeM3: 0,
        maximumDepthM: 0, maximumSpeedMps: 0, wetCellCount: 0,
        simulatedSecondsPerRealSecond: 0,
      },
    }),
    dispose: vi.fn(),
  }
}

describe('PreviewController', () => {
  it('resumes a paused solver without rebuilding or resetting it', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const instance = solver(grid())
    const factory = vi.fn(() => instance)
    const controller = new PreviewController({ grid: instance.grid, scenario: scenario() }, factory)
    controller.start()
    controller.pause()
    controller.setPlaybackRate(180)
    controller.start()
    expect(controller.status().phase).toBe('running')
    expect(controller.status().playbackRate).toBe(180)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(instance.reset).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('keeps invalidated sessions stale until they are rebuilt', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const instance = solver(grid())
    const controller = new PreviewController(
      { grid: instance.grid, scenario: scenario() }, () => instance,
    )
    controller.start()
    controller.invalidate()
    controller.reset()
    controller.start()
    expect(controller.status().phase).toBe('stale')
    expect(instance.reset).not.toHaveBeenCalled()
    controller.dispose()
  })
})
