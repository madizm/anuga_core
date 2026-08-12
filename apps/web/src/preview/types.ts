import type { FlowField, ScenarioPayload } from '../api/types'
import type { GridCorners } from '../map/simulationGrid'

export const PREVIEW_DRY_DEPTH_M = 0.01
export const PREVIEW_GRAVITY_MPS2 = 9.81

export type PreviewMode = 'animated' | 'static'

export const PREVIEW_MODE_CONFIG = {
  animated: { maxCells: 262_144, snapshotIntervalSeconds: 0 },
  static: { maxCells: 1_048_576, snapshotIntervalSeconds: 1_800 },
} as const satisfies Record<PreviewMode, { maxCells: number; snapshotIntervalSeconds: number }>

/** Dense, south-to-north grid used by both the CPU reference and GPU solver. */
export interface PreviewStructureLink {
  id: string
  type: 'culvert' | 'bridge'
  inletCell: number
  outletCell: number
  areaM2: number
  blockage: number
  lossCoefficient: number
}

export interface PreviewHydraulicModel {
  bedElevationM: Float32Array
  manningN: Float32Array
  sourceDepthRateMps: Float32Array
  outletCapacityM3s: Float32Array
  outletFullCapacityDepthM: Float32Array
  outletBlockage: Float32Array
  wallX: Float32Array
  wallY: Float32Array
  crestX: Float32Array
  crestY: Float32Array
  qFactorX: Float32Array
  qFactorY: Float32Array
  links: PreviewStructureLink[]
  approximatedFeatures: string[]
  unsupportedFeatures: string[]
}

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
  hydraulics?: PreviewHydraulicModel
}

export interface PreviewCapabilities {
  supported: boolean
  webgl2: boolean
  floatFramebuffer: boolean
  maxTextureSize: number
  staticSupported: boolean
  staticReason: string | null
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
  structureOutflowM3?: number
  massResidualM3?: number
}

export interface PreviewSnapshot {
  timeSeconds: number
  field: FlowField
  diagnostics: PreviewDiagnostics
}

export interface PreviewStatus {
  mode: PreviewMode
  phase: PreviewPhase
  timeSeconds: number
  durationSeconds: number
  playbackRate: number
  gridCellCount: number
  snapshotIntervalSeconds: number
  nextSnapshotTimeSeconds: number | null
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
  mode?: PreviewMode
  snapshotIntervalSeconds?: number
  playbackRate?: number
}
