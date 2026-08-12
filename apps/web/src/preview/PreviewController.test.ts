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

function longScenario(): ScenarioPayload {
  return { ...scenario(), durationSeconds: 3_700 }
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
  it('creates static map snapshots only at exact simulated-time boundaries', () => {
    let frame: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frame = callback
      return 1
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const instance = solver(grid())
    instance.recommendedTimeStepSeconds = () => 600
    instance.snapshot = vi.fn(instance.snapshot)
    const controller = new PreviewController({
      grid: instance.grid,
      scenario: longScenario(),
      mode: 'static',
      playbackRate: 3_600,
    }, () => instance)
    controller.start()
    const firstFrame = frame as FrameRequestCallback | null
    expect(firstFrame).not.toBeNull()
    firstFrame!(performance.now() + 500)
    expect(instance.snapshot).toHaveBeenCalledTimes(2)
    expect(instance.snapshot).toHaveBeenLastCalledWith(1_800)
    expect(controller.status()).toMatchObject({
      mode: 'static', snapshotIntervalSeconds: 1_800, nextSnapshotTimeSeconds: 3_600,
    })
    controller.dispose()
  })

  it('never steps across a rainfall change or static snapshot boundary', () => {
    let frame: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frame = callback
      return 1
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const instance = solver(grid())
    instance.recommendedTimeStepSeconds = () => 1_000
    const rainy = longScenario()
    rainy.rainfall = {
      enabled: true,
      points: [
        { timeMinutes: 0, intensityMmPerHour: 0 },
        { timeMinutes: 10, intensityMmPerHour: 36 },
      ],
    }
    const controller = new PreviewController({
      grid: instance.grid, scenario: rainy, mode: 'static',
    }, () => instance)
    controller.start()
    const firstFrame = frame as FrameRequestCallback | null
    firstFrame!(performance.now() + 500)
    const calls = vi.mocked(instance.step).mock.calls
    expect(calls.slice(0, 3).map(([dt]) => dt)).toEqual([600, 1_000, 200])
    expect(calls[0][1]).toBe(0)
    expect(calls[1][1]).toBeCloseTo(0.00001)
    expect(calls[2][1]).toBeCloseTo(0.00001)
    controller.dispose()
  })

  it('snaps floating-point rainfall boundaries before applying the new rate', () => {
    let frame: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frame = callback
      return 1
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const instance = solver(grid())
    const steps = [599.99999995, 1_000]
    instance.recommendedTimeStepSeconds = () => steps.shift() ?? 1_000
    const rainy = longScenario()
    rainy.rainfall = {
      enabled: true,
      points: [
        { timeMinutes: 0, intensityMmPerHour: 0 },
        { timeMinutes: 10, intensityMmPerHour: 36 },
      ],
    }
    const controller = new PreviewController({
      grid: instance.grid, scenario: rainy, mode: 'static',
    }, () => instance)
    controller.start()
    frame!(performance.now() + 500)
    const calls = vi.mocked(instance.step).mock.calls
    expect(calls[0]).toEqual([599.99999995, 0])
    expect(calls[1][0]).toBe(1_000)
    expect(calls[1][1]).toBeCloseTo(0.00001)
    controller.dispose()
  })

  it('snaps floating-point static snapshot boundaries before readback', () => {
    let frame: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frame = callback
      return 1
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const instance = solver(grid())
    const steps = [1_799.99999995, 1_000]
    instance.recommendedTimeStepSeconds = () => steps.shift() ?? 1_000
    instance.snapshot = vi.fn(instance.snapshot)
    const controller = new PreviewController({
      grid: instance.grid, scenario: longScenario(), mode: 'static',
    }, () => instance)
    controller.start()
    frame!(performance.now() + 500)
    expect(controller.status().phase).toBe('running')
    expect(controller.status().timeSeconds).toBe(1_800)
    expect(instance.snapshot).toHaveBeenLastCalledWith(1_800)
    expect(instance.step).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('retains the last boundary snapshot when static work pauses mid-interval', () => {
    let frame: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frame = callback
      return 1
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const instance = solver(grid())
    instance.snapshot = vi.fn(instance.snapshot)
    const controller = new PreviewController({
      grid: instance.grid, scenario: longScenario(), mode: 'static',
    }, () => instance)
    controller.start()
    frame!(performance.now() + 500)
    expect(controller.status().timeSeconds).toBe(64)
    controller.pause()
    expect(controller.status().phase).toBe('paused')
    expect(instance.snapshot).toHaveBeenCalledTimes(1)
    expect(controller.status().snapshot?.timeSeconds).toBe(0)
    controller.dispose()
  })

  it('disposes the solver when the initial snapshot fails', () => {
    const instance = solver(grid())
    instance.snapshot = vi.fn(() => { throw new Error('readback failed') })
    expect(() => new PreviewController({
      grid: instance.grid, scenario: scenario(),
    }, () => instance)).toThrow('readback failed')
    expect(instance.dispose).toHaveBeenCalledOnce()
  })

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
