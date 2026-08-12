import { rainfallRateMps } from './previewScenario'
import type {
  PreviewMode, PreviewSessionInput, PreviewSolver, PreviewStatus,
} from './types'
import { PREVIEW_MODE_CONFIG } from './types'
import { WebGL2PreviewSolver } from './webgl2PreviewSolver'

const MAX_STEPS_PER_FRAME = 14
const MAX_STATIC_STEPS_PER_FRAME = 64
const STATIC_FRAME_BUDGET_MS = 20
const STATIC_PROGRESS_INTERVAL_MS = 250
const MAX_BACKLOG_REAL_SECONDS = 0.5
const PREVIEW_SNAPSHOT_INTERVAL_MS = 1000 / 15
const DEFAULT_PLAYBACK_RATE = 60
const TIME_BOUNDARY_EPSILON_SECONDS = 1e-7

type Listener = (status: PreviewStatus) => void

type SolverFactory = (input: PreviewSessionInput['grid']) => PreviewSolver

export class PreviewController {
  private readonly listeners = new Set<Listener>()
  private readonly solver: PreviewSolver
  private statusValue: PreviewStatus
  private animationFrame: number | null = null
  private lastWallTime = 0
  private backlogSeconds = 0
  private lastSnapshotWallTime = 0
  private lastProgressEmitWallTime = 0
  private disposed = false
  private readonly mode: PreviewMode
  private readonly snapshotIntervalSeconds: number

  constructor(
    private readonly input: PreviewSessionInput,
    solverFactory: SolverFactory = (grid) => new WebGL2PreviewSolver(grid),
  ) {
    this.mode = input.mode ?? 'animated'
    this.snapshotIntervalSeconds = input.snapshotIntervalSeconds
      ?? PREVIEW_MODE_CONFIG[this.mode].snapshotIntervalSeconds
    if (this.mode === 'static' && (
      !Number.isFinite(this.snapshotIntervalSeconds) || this.snapshotIntervalSeconds <= 0
    )) throw new Error('静态快照间隔必须大于零')
    const solver = solverFactory(input.grid)
    this.solver = solver
    try {
      this.statusValue = {
        mode: this.mode,
        phase: 'idle',
        timeSeconds: 0,
        durationSeconds: input.scenario.durationSeconds,
        playbackRate: input.playbackRate ?? (this.mode === 'static' ? 3_600 : DEFAULT_PLAYBACK_RATE),
        gridCellCount: input.grid.width * input.grid.height,
        snapshotIntervalSeconds: this.snapshotIntervalSeconds,
        nextSnapshotTimeSeconds: this.nextSnapshotAfter(0),
        snapshot: solver.snapshot(0),
        error: null,
      }
    } catch (error) {
      solver.dispose()
      throw error
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
    if (this.mode === 'static') {
      this.statusValue = { ...this.statusValue, phase: 'paused' }
      this.emit()
      return
    }
    try {
      this.statusValue = {
        ...this.statusValue,
        phase: 'paused',
        snapshot: this.solver.snapshot(this.statusValue.timeSeconds),
      }
      this.lastSnapshotWallTime = performance.now()
    } catch (error) {
      this.statusValue = {
        ...this.statusValue,
        phase: 'error',
        error: (error as Error).message || '快速预览状态读取失败',
      }
    }
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
      nextSnapshotTimeSeconds: this.nextSnapshotAfter(0),
      snapshot: this.solver.snapshot(0),
      error: null,
    }
    this.lastSnapshotWallTime = performance.now()
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
    if (this.mode === 'static') {
      this.backlogSeconds = Math.max(
        this.backlogSeconds,
        Math.min(this.snapshotIntervalSeconds, this.statusValue.durationSeconds - this.statusValue.timeSeconds),
      )
    }
    const startedAt = this.statusValue.timeSeconds
    let timeSeconds = startedAt
    let steps = 0
    const frameStartedAt = performance.now()
    try {
      while (
        this.backlogSeconds > 1e-7
        && timeSeconds < this.statusValue.durationSeconds
        && steps < (this.mode === 'static' ? MAX_STATIC_STEPS_PER_FRAME : MAX_STEPS_PER_FRAME)
        && (this.mode === 'animated' || steps === 0 || performance.now() - frameStartedAt < STATIC_FRAME_BUDGET_MS)
      ) {
        const nextSnapshotTime = this.statusValue.nextSnapshotTimeSeconds
        const nextRainfallChange = this.nextRainfallChangeAfter(timeSeconds)
        if (
          nextSnapshotTime != null
          && nextSnapshotTime - timeSeconds <= TIME_BOUNDARY_EPSILON_SECONDS
        ) {
          const boundaryGap = Math.max(nextSnapshotTime - timeSeconds, 0)
          timeSeconds = nextSnapshotTime
          this.backlogSeconds = Math.max(this.backlogSeconds - boundaryGap, 0)
          break
        }
        if (
          nextRainfallChange != null
          && nextRainfallChange - timeSeconds <= TIME_BOUNDARY_EPSILON_SECONDS
        ) {
          const boundaryGap = Math.max(nextRainfallChange - timeSeconds, 0)
          timeSeconds = nextRainfallChange
          this.backlogSeconds = Math.max(this.backlogSeconds - boundaryGap, 0)
          continue
        }
        const dt = Math.min(
          this.solver.recommendedTimeStepSeconds(),
          this.backlogSeconds,
          this.statusValue.durationSeconds - timeSeconds,
          nextSnapshotTime == null ? Number.POSITIVE_INFINITY : nextSnapshotTime - timeSeconds,
          nextRainfallChange == null ? Number.POSITIVE_INFINITY : nextRainfallChange - timeSeconds,
        )
        if (!Number.isFinite(dt) || dt < 1e-5) {
          throw new Error('快速预览时间步过小，当前场景超出稳定范围')
        }
        this.solver.step(dt, rainfallRateMps(this.input.scenario.rainfall, timeSeconds))
        timeSeconds += dt
        this.backlogSeconds -= dt
        steps += 1
        if (this.mode === 'static' && nextSnapshotTime != null && timeSeconds >= nextSnapshotTime) break
      }
      const completed = timeSeconds >= this.statusValue.durationSeconds
      let snapshot = this.statusValue.snapshot
      const reachedStaticSnapshot = this.mode === 'static'
        && this.statusValue.nextSnapshotTimeSeconds != null
        && timeSeconds >= this.statusValue.nextSnapshotTimeSeconds
      const shouldSnapshot = snapshot == null || completed || reachedStaticSnapshot || (
        this.mode === 'animated'
        && wallTime - this.lastSnapshotWallTime >= PREVIEW_SNAPSHOT_INTERVAL_MS
      )
      if (shouldSnapshot) {
        snapshot = this.solver.snapshot(timeSeconds)
        snapshot.diagnostics.simulatedSecondsPerRealSecond = elapsedRealSeconds > 0
          ? (timeSeconds - startedAt) / elapsedRealSeconds : 0
        this.lastSnapshotWallTime = wallTime
      }
      this.statusValue = {
        ...this.statusValue,
        phase: completed ? 'completed' : 'running',
        timeSeconds,
        nextSnapshotTimeSeconds: reachedStaticSnapshot
          ? this.nextSnapshotAfter(timeSeconds)
          : this.statusValue.nextSnapshotTimeSeconds,
        snapshot,
      }
      if (
        this.mode === 'animated' || shouldSnapshot || completed
        || wallTime - this.lastProgressEmitWallTime >= STATIC_PROGRESS_INTERVAL_MS
      ) {
        this.lastProgressEmitWallTime = wallTime
        this.emit()
      }
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

  private nextSnapshotAfter(timeSeconds: number) {
    if (this.mode !== 'static' || this.snapshotIntervalSeconds <= 0) return null
    const next = (Math.floor(timeSeconds / this.snapshotIntervalSeconds) + 1)
      * this.snapshotIntervalSeconds
    return next < this.input.scenario.durationSeconds ? next : this.input.scenario.durationSeconds
  }

  private nextRainfallChangeAfter(timeSeconds: number) {
    if (!this.input.scenario.rainfall.enabled) return null
    const next = this.input.scenario.rainfall.points.find(
      (point) => point.timeMinutes * 60 > timeSeconds,
    )
    return next ? Math.min(next.timeMinutes * 60, this.input.scenario.durationSeconds) : null
  }

  private readonly visibilityChanged = () => {
    if (document.hidden) this.pause()
  }
}
