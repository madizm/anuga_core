import { rainfallRateMps } from './previewScenario'
import type {
  PreviewSessionInput, PreviewSolver, PreviewStatus,
} from './types'
import { WebGL2PreviewSolver } from './webgl2PreviewSolver'

const MAX_STEPS_PER_FRAME = 14
const MAX_BACKLOG_REAL_SECONDS = 0.5
const DEFAULT_PLAYBACK_RATE = 60

type Listener = (status: PreviewStatus) => void

type SolverFactory = (input: PreviewSessionInput['grid']) => PreviewSolver

export class PreviewController {
  private readonly listeners = new Set<Listener>()
  private readonly solver: PreviewSolver
  private statusValue: PreviewStatus
  private animationFrame: number | null = null
  private lastWallTime = 0
  private backlogSeconds = 0
  private disposed = false

  constructor(
    private readonly input: PreviewSessionInput,
    solverFactory: SolverFactory = (grid) => new WebGL2PreviewSolver(grid),
  ) {
    this.solver = solverFactory(input.grid)
    this.statusValue = {
      phase: 'idle',
      timeSeconds: 0,
      durationSeconds: input.scenario.durationSeconds,
      playbackRate: input.playbackRate ?? DEFAULT_PLAYBACK_RATE,
      snapshot: this.solver.snapshot(0),
      error: null,
    }
    document.addEventListener('visibilitychange', this.visibilityChanged)
  }

  status() {
    return this.statusValue
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    listener(this.statusValue)
    return () => this.listeners.delete(listener)
  }

  start() {
    if (
      this.disposed
      || this.statusValue.phase === 'running'
      || this.statusValue.phase === 'stale'
    ) return
    if (this.statusValue.phase === 'completed') this.reset()
    this.statusValue = { ...this.statusValue, phase: 'running', error: null }
    this.lastWallTime = performance.now()
    this.backlogSeconds = 0
    this.emit()
    this.schedule()
  }

  pause() {
    if (this.disposed || this.statusValue.phase !== 'running') return
    this.cancelFrame()
    this.statusValue = { ...this.statusValue, phase: 'paused' }
    this.emit()
  }

  invalidate() {
    if (this.disposed || this.statusValue.phase === 'idle' || this.statusValue.phase === 'stale') return
    this.cancelFrame()
    this.statusValue = { ...this.statusValue, phase: 'stale' }
    this.emit()
  }

  reset() {
    if (this.disposed || this.statusValue.phase === 'stale') return
    this.cancelFrame()
    this.solver.reset()
    this.backlogSeconds = 0
    this.statusValue = {
      ...this.statusValue,
      phase: 'paused',
      timeSeconds: 0,
      snapshot: this.solver.snapshot(0),
      error: null,
    }
    this.emit()
  }

  setPlaybackRate(playbackRate: number) {
    if (!Number.isFinite(playbackRate) || playbackRate <= 0) return
    this.statusValue = { ...this.statusValue, playbackRate }
    this.backlogSeconds = 0
    this.lastWallTime = performance.now()
    this.emit()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.cancelFrame()
    document.removeEventListener('visibilitychange', this.visibilityChanged)
    this.solver.dispose()
    this.listeners.clear()
  }

  private readonly tick = (wallTime: number) => {
    this.animationFrame = null
    if (this.disposed || this.statusValue.phase !== 'running') return
    const elapsedRealSeconds = Math.min(
      Math.max((wallTime - this.lastWallTime) / 1000, 0),
      MAX_BACKLOG_REAL_SECONDS,
    )
    this.lastWallTime = wallTime
    this.backlogSeconds = Math.min(
      this.backlogSeconds + elapsedRealSeconds * this.statusValue.playbackRate,
      this.statusValue.playbackRate * MAX_BACKLOG_REAL_SECONDS,
    )
    const startedAt = this.statusValue.timeSeconds
    let timeSeconds = startedAt
    let steps = 0
    try {
      while (
        this.backlogSeconds > 1e-7
        && timeSeconds < this.statusValue.durationSeconds
        && steps < MAX_STEPS_PER_FRAME
      ) {
        const dt = Math.min(
          this.solver.recommendedTimeStepSeconds(),
          this.backlogSeconds,
          this.statusValue.durationSeconds - timeSeconds,
        )
        if (!Number.isFinite(dt) || dt < 1e-5) {
          throw new Error('快速预览时间步过小，当前场景超出稳定范围')
        }
        this.solver.step(dt, rainfallRateMps(this.input.scenario.rainfall, timeSeconds))
        timeSeconds += dt
        this.backlogSeconds -= dt
        steps += 1
      }
      const snapshot = this.solver.snapshot(timeSeconds)
      snapshot.diagnostics.simulatedSecondsPerRealSecond = elapsedRealSeconds > 0
        ? (timeSeconds - startedAt) / elapsedRealSeconds : 0
      this.statusValue = {
        ...this.statusValue,
        phase: timeSeconds >= this.statusValue.durationSeconds ? 'completed' : 'running',
        timeSeconds,
        snapshot,
      }
      this.emit()
      if (this.statusValue.phase === 'running') this.schedule()
    } catch (error) {
      this.statusValue = {
        ...this.statusValue,
        phase: 'error',
        error: (error as Error).message || '快速预览失败',
      }
      this.emit()
    }
  }

  private schedule() {
    if (this.animationFrame == null) this.animationFrame = requestAnimationFrame(this.tick)
  }

  private cancelFrame() {
    if (this.animationFrame != null) cancelAnimationFrame(this.animationFrame)
    this.animationFrame = null
  }

  private emit() {
    for (const listener of this.listeners) listener(this.statusValue)
  }

  private readonly visibilityChanged = () => {
    if (document.hidden) this.pause()
  }
}
