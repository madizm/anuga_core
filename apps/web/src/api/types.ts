import type { FeatureCollection } from 'geojson'

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

export type Position = [number, number]

interface HydraulicFeatureBase {
  id: string
  name: string
  enabled: boolean
}

export interface LeveeFeature extends HydraulicFeatureBase {
  type: 'levee'
  geometry: { type: 'LineString'; coordinates: Position[] }
  crestMode: 'absolute' | 'relative' | 'profile'
  crestElevationM?: number
  heightAboveGroundM?: number
  crestElevationsM?: number[]
  qFactor: number
}

export interface SimpleChannelFeature extends HydraulicFeatureBase {
  type: 'simpleChannel'
  geometry: { type: 'Polygon'; coordinates: Position[][] }
  elevationMode: 'lowerBy' | 'absolute'
  depthM?: number
  elevationM?: number
  manningN: number
  maxTriangleAreaM2: number
}

export interface ChannelCrossSection {
  distanceM: number
  bedElevationM: number
  bottomWidthM: number
  sideSlope: number
}

export interface EngineeringChannelFeature extends HydraulicFeatureBase {
  type: 'engineeringChannel'
  geometry: { type: 'LineString'; coordinates: Position[] }
  crossSections: ChannelCrossSection[]
  bankHeightM: number
  manningN: number
  maxTriangleAreaM2: number
}

export interface CulvertFeature extends HydraulicFeatureBase {
  type: 'culvert'
  geometry: { type: 'LineString'; coordinates: Position[] }
  shape: 'box' | 'pipe'
  widthM?: number
  heightM?: number
  diameterM?: number
  barrels: number
  blockage: number
  losses: number
  manningN: number
  invertElevationsM?: [number, number]
}

export interface BridgeFeature extends HydraulicFeatureBase {
  type: 'bridge'
  geometry: { type: 'LineString'; coordinates: Position[] }
  widthM: number
  heightM: number
  leftSideSlope: number
  rightSideSlope: number
  blockage: number
  losses: number
  manningN: number
  invertElevationsM?: [number, number]
}

export interface DrainageOutletFeature extends HydraulicFeatureBase {
  type: 'drainageOutlet'
  geometry: { type: 'Point'; coordinates: Position }
  capacityM3s: number
  intakeRadiusM: number
  fullCapacityDepthM: number
  blockage: number
}

export interface BreachFeature extends HydraulicFeatureBase {
  type: 'breach'
  leveeId: string
  geometry: { type: 'Point'; coordinates: Position }
  widthM: number
  crestElevationM: number
}

export type HydraulicFeature = LeveeFeature | SimpleChannelFeature
  | EngineeringChannelFeature | CulvertFeature | BridgeFeature
  | DrainageOutletFeature | BreachFeature


export interface ScenarioPayload {
  demProductId: string
  simulationAreaId: string
  name: string
  durationSeconds: number
  yieldstepSeconds: number
  frictionScenario: FrictionScenario
  inlets: Inlet[]
  rainfall: Rainfall
  hydraulicFeatures: HydraulicFeature[]
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
    hydraulicFeatureCount: number
    leveeCount: number
    channelCount: number
    structureCount: number
    customMeshRequired: boolean
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

export type FlowGridCorners = [
  northwest: [number, number],
  northeast: [number, number],
  southwest: [number, number],
  southeast: [number, number],
]

export interface FlowField {
  width: number
  height: number
  bounds: [number, number, number, number]
  /** Exact geographic corners of the source raster grid (BQFV v4; null for legacy payloads). */
  corners: FlowGridCorners | null
  /**
   * Interleaved (u, v) velocity components for CPU consumers (particles).
   * NaN outside wet cells for v1/v2 fields; 0 for dry cells in v3.
   */
  vectors: Float32Array
  /** Per-cell water depth in metres (BQFV v2 only); null otherwise. */
  depths: Float32Array | null
  /**
   * v3/v4 texture-ready fp16 RGBA texels (u, v, depth, stage) — upload
   * verbatim as RGBA16F/HALF_FLOAT. Dry cells carry the depth sentinel -1.
   * Null for legacy v1/v2 fields.
   */
  texels: Uint16Array | null
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
  gridManifestUrl: string
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

export interface ElevationProfile {
  lengthM: number
  spacingM: number
  samples: Array<{
    distanceM: number
    elevationM: number
    longitude: number
    latitude: number
  }>
}

export interface HydraulicMeshPreview extends FeatureCollection {
  triangleCount: number
  edgeCount: number
  displayedEdgeCount: number
  decimated: boolean
}


export type FullPreviewStatus = 'QUEUED' | 'PREPARING' | 'SOLVING'
  | 'PUBLISHING' | 'COMPLETED' | 'FAILED'

export interface FullPreviewConfig {
  available: boolean
  domainId: string
  demProductId: string
  durationHours: number
  cacheStatus: 'READY' | 'MISSING' | 'INVALID'
  readinessError: string | null
  windowConfigured: boolean
  datasetVersion: string | null
  cacheIdentityHash: string | null
  rainfallLimitsMm: { minimum: number; maximum: number }
  assumptionsProfile: {
    id: string
    name: string
    runoffCoefficient: number
    drainageIncluded: boolean
    infiltrationIncluded: boolean
    spatialDistribution: 'uniform'
  }
  authority: 'non-authoritative'
}

export interface FullPreviewResult {
  tilejsonUrl: string
  cogDownloadUrl: string
  bounds: [number, number, number, number]
  maximumDepthM: number
  wetAreaM2: number
  thresholdAreasM2: Record<string, number>
  inputVolumeM3: number
  retainedVolumeM3: number
  outflowVolumeM3: number
  massBalanceErrorM3: number
}

export interface FullPreviewJob {
  id: string
  status: FullPreviewStatus
  phase: string | null
  demProductId: string
  domainId: string
  datasetVersion: string
  rainfallDepthMm: number
  effectiveRainfallDepthMm: number
  assumptionsProfileId: string
  runoffCoefficient: number
  cacheIdentityHash: string
  compatibilityVersion: string
  cacheHit: boolean | null
  result: FullPreviewResult | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  authority: 'non-authoritative'
}

export interface FullPreviewPoint {
  longitude: number
  latitude: number
  maximumDepthM: number | null
}
