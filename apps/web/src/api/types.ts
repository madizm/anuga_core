export type VelocityMode = 'zero' | 'components' | 'bearing'
export type FrictionScenario = 'low' | 'middle' | 'high'

export interface Inlet {
  id: string
  name: string
  enabled: boolean
  cellIds: string[]
  dischargeM3s: number
  velocityMode: VelocityMode
  velocityUMps?: number
  velocityVMps?: number
  speedMps?: number
  bearingDegrees?: number
  initialWaterLevelM: number | null
  displayColor: string
}

export interface ScenarioPayload {
  simulationAreaId: string
  name: string
  durationSeconds: number
  yieldstepSeconds: number
  frictionScenario: FrictionScenario
  inlets: Inlet[]
}

export interface ValidationIssue {
  code: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  summary: null | {
    enabledInletCount: number
    totalDischargeM3s: number
    totalInputVolumeM3: number
    frameCount: number
    simulationAreaId: string
    datasetVersion: string
    boundaryCondition: string
  }
}

export interface ModelMetadata {
  version: string
  crs: string
  gridRows: number
  gridColumns: number
  cellSizeM: number
  datasetVersion: string
  simulationAreaResolveUrl: string
  maxSimulationAreaCells: number
  demTilejsonUrl: string
  boundaryCondition: string
}

export interface SavedScenario extends ScenarioPayload {
  id: string
  createdAt: string
  updatedAt: string
}

export interface SimulationJob {
  id: string
  scenarioId: string
  simulationAreaId: string
  simulationAreaBounds: [number, number, number, number] | null
  scenarioSnapshot: ScenarioPayload
  status: 'QUEUED' | 'PREPARING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  currentFrame: number
  frameCount: number
  simulationTimeSeconds: number
  maximumDepthM: number | null
  appliedVolumeM3: number | null
  finalWaterVolumeM3: number | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  errorCode: string | null
  errorMessage: string | null
}

export type ResultQuantity = 'depth' | 'stage' | 'speed'

export interface SimulationFrame {
  jobId: string
  frameIndex: number
  timeSeconds: number
  maximumDepthM: number
  maximumSpeedMps: number
  wetAreaM2: number
  tilejson: Record<ResultQuantity, string>
  createdAt: string
}

export interface FramePointValue {
  timeSeconds: number
  longitude: number
  latitude: number
  depthM: number | null
  stageM: number | null
  speedMps: number | null
}


export interface SimulationArea {
  id: string
  areaHash: string
  datasetVersion: string
  crs: string
  cellCount: number
  areaM2: number
  cellSizeM: number
  triangleCount: number
  window: {
    rowStart: number
    rowStop: number
    columnStart: number
    columnStop: number
  }
  elevationM: { minimum: number; maximum: number; mean: number }
  gridUrl: string
  boundaryCondition: string
}

export interface SelectionStats {
  cellIds: string[]
  cellCount: number
  geometricAreaM2: number
  triangleCount: number
  effectiveTriangleAreaM2: number
  elevationM: { minimum: number; maximum: number; mean: number }
  buildingFraction: { minimum: number; maximum: number }
  manning: { minimum: number; maximum: number }
}
