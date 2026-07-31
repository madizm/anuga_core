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

export interface RainfallPoint {
  timeMinutes: number
  intensityMmPerHour: number
}

export interface Rainfall {
  enabled: boolean
  points: RainfallPoint[]
}

export interface ScenarioPayload {
  demProductId: string
  simulationAreaId: string
  name: string
  durationSeconds: number
  yieldstepSeconds: number
  frictionScenario: FrictionScenario
  inlets: Inlet[]
  rainfall: Rainfall
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
    rainfallEnabled: boolean
    rainfallPointCount: number
    rainfallDepthMm: number
    peakRainfallMmPerHour: number
    rainfallInputVolumeM3: number
    totalInputVolumeM3: number
    frameCount: number
    simulationAreaId: string
    demProductId: string
    datasetVersion: string
    boundaryCondition: string
  }
}

export interface DemProduct {
  id: string
  name: string
  status: 'active' | 'deprecated' | 'unavailable'
  isDefault: boolean
  crs: string
  cellSizeM: number
  sourceResolutionM: number
  informationResolutionM: number
  datasetVersion: string
  verticalDatum: string
  elevationUnit: string
  resamplingMethod: 'original' | 'bilinear'
  maxCells: number
  maxTriangles: number
  resourceQueue: string
  demSha256: string
  simulationAreaResolveUrl: string
  demTilejsonUrl: string
  terrainTilejsonUrl: string
  derived: boolean
}

export interface DemProductCatalog {
  defaultDemProductId: string
  products: DemProduct[]
}

export interface SavedScenario extends ScenarioPayload {
  id: string
  createdAt: string
  updatedAt: string
}

export interface SimulationJob {
  id: string
  scenarioId: string
  demProductId: string
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

export interface FlowField {
  width: number
  height: number
  bounds: [number, number, number, number]
  vectors: Float32Array
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
  demProductId: string
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
