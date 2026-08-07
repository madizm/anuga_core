import type { FlowField, ScenarioPayload } from '../api/types'
import type { GridCorners } from '../map/simulationGrid'

export const PREVIEW_DRY_DEPTH_M = 0.01
export const PREVIEW_GRAVITY_MPS2 = 9.81

/** Dense, south-to-north grid used by both the CPU reference and GPU solver. */
export interface DensePreviewGrid {
  width: number
  height: number
  cellSizeM: number
  corners: GridCorners
  /** 1 active, 0 exterior/open, -1 enclosed NoData/solid. */
  mask: Float32Array
  elevationM: Float32Array
  manningN: Float32Array
  inletDepthRateMps: Float32Array
  inletXMomentumRate: Float32Array
  inletYMomentumRate: Float32Array
  initialState: Float32Array
  activeCellCount: number
  activeAreaM2: number
  initialWaterVolumeM3: number
  inletDischargeM3s: number
}

export interface PreviewCapabilities {
  supported: boolean
  webgl2: boolean
  floatFramebuffer: boolean
  maxTextureSize: number
  reason: string | null
}

export type PreviewPhase = 'idle' | 'running' | 'paused' | 'stale' | 'completed' | 'error'

export interface PreviewDiagnostics {
  timeStepSeconds: number
  waterVolumeM3: number
  appliedInputVolumeM3: number
  maximumDepthM: number
  maximumSpeedMps: number
  wetCellCount: number
  simulatedSecondsPerRealSecond: number
}

export interface PreviewSnapshot {
  timeSeconds: number
  field: FlowField
  diagnostics: PreviewDiagnostics
}

export interface PreviewStatus {
  phase: PreviewPhase
  timeSeconds: number
  durationSeconds: number
  playbackRate: number
  snapshot: PreviewSnapshot | null
  error: string | null
}

export interface PreviewSolver {
  readonly grid: DensePreviewGrid
  reset(): void
  recommendedTimeStepSeconds(): number
  step(timeStepSeconds: number, rainfallRateMps: number): void
  snapshot(timeSeconds: number): PreviewSnapshot
  dispose(): void
}

export interface PreviewSessionInput {
  grid: DensePreviewGrid
  scenario: ScenarioPayload
  playbackRate?: number
}
