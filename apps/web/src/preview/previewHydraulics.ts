import type {
  BreachFeature,
  HydraulicFeature,
  LeveeFeature,
  Position,
  SimpleChannelFeature,
} from '../api/types'
import type { DensePreviewGrid, PreviewHydraulicModel } from './types'

const FACE_EPSILON = 0.08

/**
 * Compiles business hydraulic features into the small numerical interface
 * consumed by both preview solver Adapters. Unsupported structures remain in
 * diagnostics; this module never silently drops an enabled feature.
 */
export function compilePreviewHydraulics(
  grid: DensePreviewGrid,
  features: HydraulicFeature[],
): PreviewHydraulicModel {
  const cellCount = grid.width * grid.height
  const model: PreviewHydraulicModel = {
    bedElevationM: new Float32Array(grid.elevationM),
    manningN: new Float32Array(grid.manningN),
    sourceDepthRateMps: new Float32Array(cellCount),
    outletCapacityM3s: new Float32Array(cellCount),
    outletFullCapacityDepthM: new Float32Array(cellCount),
    outletBlockage: new Float32Array(cellCount),
    wallX: new Float32Array((grid.width + 1) * grid.height),
    wallY: new Float32Array(grid.width * (grid.height + 1)),
    crestX: filledNaN((grid.width + 1) * grid.height),
    crestY: filledNaN(grid.width * (grid.height + 1)),
    qFactorX: new Float32Array((grid.width + 1) * grid.height).fill(1),
    qFactorY: new Float32Array(grid.width * (grid.height + 1)).fill(1),
    links: [],
    approximatedFeatures: [],
    unsupportedFeatures: [],
  }
  const leveeFaces = new Map<string, FaceRef[]>()

  const orderedFeatures = features
    .filter((feature) => feature.enabled)
    .sort((left, right) => featurePriority(left) - featurePriority(right))
  for (const feature of orderedFeatures) {
    const label = featureName(feature)
    if (feature.type === 'simpleChannel') {
      compileSimpleChannel(grid, model, feature)
      model.approximatedFeatures.push(label)
    } else if (feature.type === 'levee') {
      const faces = compileLevee(grid, model, feature)
      leveeFaces.set(feature.id, faces)
      model.approximatedFeatures.push(label)
    } else if (feature.type === 'drainageOutlet') {
      compileOutlet(grid, model, feature)
      model.approximatedFeatures.push(label)
    } else if (feature.type === 'breach') {
      const faces = leveeFaces.get(feature.leveeId)
      if (!faces) {
        model.unsupportedFeatures.push(`${feature.name}（缺少关联堤防）`)
      } else {
        removeBreach(grid, model, faces, feature)
        model.approximatedFeatures.push(label)
      }
    } else {
      model.unsupportedFeatures.push(label)
    }
  }
  return model
}

interface FaceRef {
  axis: 'x' | 'y'
  index: number
  x: number
  y: number
}

function compileSimpleChannel(
  grid: DensePreviewGrid,
  model: PreviewHydraulicModel,
  feature: SimpleChannelFeature,
) {
  forEachActiveCell(grid, (cell, x, y) => {
    const point = denseCellCenter(grid, x, y)
    if (!pointInPolygon(point, feature.geometry.coordinates)) return
    const bed = feature.elevationMode === 'absolute'
      ? feature.elevationM
      : model.bedElevationM[cell] - (feature.depthM ?? 0)
    if (Number.isFinite(bed)) model.bedElevationM[cell] = bed as number
    if (feature.manningN > 0) model.manningN[cell] = feature.manningN
  })
}

function compileLevee(
  grid: DensePreviewGrid,
  model: PreviewHydraulicModel,
  feature: LeveeFeature,
): FaceRef[] {
  const faces: FaceRef[] = []
  const coordinates = feature.geometry.coordinates
  for (let segment = 1; segment < coordinates.length; segment += 1) {
    const start = toDensePoint(grid, coordinates[segment - 1])
    const end = toDensePoint(grid, coordinates[segment])
    if (!start || !end) continue
    const distance = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y))
    const samples = Math.max(1, Math.ceil(distance * 4))
    for (let sample = 0; sample <= samples; sample += 1) {
      const t = sample / samples
      const x = start.x + (end.x - start.x) * t
      const y = start.y + (end.y - start.y) * t
      const vertical = Math.abs(end.y - start.y) >= Math.abs(end.x - start.x)
      if (vertical) {
        const faceX = Math.round(x)
        const cellY = Math.floor(y)
        if (faceX < 0 || faceX > grid.width || cellY < 0 || cellY >= grid.height) continue
        const index = cellY * (grid.width + 1) + faceX
        model.wallX[index] = 1
        model.crestX[index] = crestElevation(grid, feature, x, y)
        model.qFactorX[index] = Math.max(0, feature.qFactor)
        faces.push({ axis: 'x', index, x: faceX, y: cellY + 0.5 })
      } else {
        const faceY = Math.round(y)
        const cellX = Math.floor(x)
        if (cellX < 0 || cellX >= grid.width || faceY < 0 || faceY > grid.height) continue
        const index = faceY * grid.width + cellX
        model.wallY[index] = 1
        model.crestY[index] = crestElevation(grid, feature, x, y)
        model.qFactorY[index] = Math.max(0, feature.qFactor)
        faces.push({ axis: 'y', index, x: cellX + 0.5, y: faceY })
      }
    }
  }
  return uniqueFaces(faces)
}

function compileOutlet(
  grid: DensePreviewGrid,
  model: PreviewHydraulicModel,
  feature: Extract<HydraulicFeature, { type: 'drainageOutlet' }>,
) {
  const center = toDensePoint(grid, feature.geometry.coordinates)
  if (!center) return
  const radiusCells = Math.max(0.5, feature.intakeRadiusM / grid.cellSizeM)
  const selected: number[] = []
  forEachActiveCell(grid, (cell, x, y) => {
    if (Math.hypot(x + 0.5 - center.x, y + 0.5 - center.y) <= radiusCells) selected.push(cell)
  })
  if (selected.length === 0) {
    const nearest = nearestActiveCell(grid, center)
    if (nearest != null) selected.push(nearest)
  }
  const capacity = Math.max(0, feature.capacityM3s) * (1 - clamp(feature.blockage, 0, 1))
  for (const cell of selected) {
    model.outletCapacityM3s[cell] += capacity / Math.max(1, selected.length)
    model.outletFullCapacityDepthM[cell] = Math.max(
      model.outletFullCapacityDepthM[cell], feature.fullCapacityDepthM,
    )
    model.outletBlockage[cell] = 0
  }
}

function removeBreach(
  grid: DensePreviewGrid,
  model: PreviewHydraulicModel,
  faces: FaceRef[],
  feature: BreachFeature,
) {
  const center = toDensePoint(grid, feature.geometry.coordinates)
  if (!center) return
  const radius = Math.max(0.5, feature.widthM / grid.cellSizeM / 2)
  for (const face of faces) {
    if (Math.hypot(face.x - center.x, face.y - center.y) > radius + FACE_EPSILON) continue
    if (face.axis === 'x') {
      model.wallX[face.index] = 0
      model.crestX[face.index] = Number.NaN
    } else {
      model.wallY[face.index] = 0
      model.crestY[face.index] = Number.NaN
    }
  }
}

function crestElevation(
  grid: DensePreviewGrid,
  feature: LeveeFeature,
  x: number,
  y: number,
): number {
  if (feature.crestMode === 'absolute') return feature.crestElevationM ?? 0
  if (feature.crestMode === 'profile' && feature.crestElevationsM?.length) {
    const index = Math.min(feature.crestElevationsM.length - 1, Math.max(0, Math.round(y)))
    return feature.crestElevationsM[index]
  }
  const cellX = Math.min(grid.width - 1, Math.max(0, Math.floor(x)))
  const cellY = Math.min(grid.height - 1, Math.max(0, Math.floor(y)))
  const cell = cellY * grid.width + cellX
  return (Number.isFinite(grid.elevationM[cell]) ? grid.elevationM[cell] : 0)
    + (feature.heightAboveGroundM ?? 0)
}

function forEachActiveCell(
  grid: DensePreviewGrid,
  callback: (cell: number, x: number, y: number) => void,
) {
  for (let cell = 0; cell < grid.mask.length; cell += 1) {
    if (grid.mask[cell] === 1) callback(cell, cell % grid.width, Math.floor(cell / grid.width))
  }
}

function nearestActiveCell(grid: DensePreviewGrid, point: DensePoint): number | null {
  let nearest: number | null = null
  let distance = Infinity
  forEachActiveCell(grid, (cell, x, y) => {
    const current = Math.hypot(x + 0.5 - point.x, y + 0.5 - point.y)
    if (current < distance) {
      distance = current
      nearest = cell
    }
  })
  return nearest
}

interface DensePoint { x: number; y: number }

function toDensePoint(grid: DensePreviewGrid, position: Position): DensePoint | null {
  const [northWest, northEast, southWest] = grid.corners
  const width = northEast[0] - northWest[0]
  const height = northWest[1] - southWest[1]
  if (Math.abs(width) < 1e-12 || Math.abs(height) < 1e-12) return null
  const u = (position[0] - northWest[0]) / width
  const northToSouth = (northWest[1] - position[1]) / height
  return { x: u * grid.width, y: (1 - northToSouth) * grid.height }
}

function denseCellCenter(grid: DensePreviewGrid, x: number, y: number): Position {
  const [northWest, northEast, southWest, southEast] = grid.corners
  const u = (x + 0.5) / grid.width
  const denseSouthWeight = 1 - (y + 0.5) / grid.height
  return [
    northWest[0] * (1 - u) * denseSouthWeight
      + northEast[0] * u * denseSouthWeight
      + southWest[0] * (1 - u) * (1 - denseSouthWeight)
      + southEast[0] * u * (1 - denseSouthWeight),
    northWest[1] * denseSouthWeight + southWest[1] * (1 - denseSouthWeight),
  ]
}

function pointInPolygon(point: Position, polygon: Position[][]): boolean {
  if (!pointInRing(point, polygon[0] ?? [])) return false
  return polygon.slice(1).every((hole) => !pointInRing(point, hole))
}

function pointInRing([x, y]: Position, ring: Position[]): boolean {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index]
    const [xj, yj] = ring[previous]
    const intersects = (yi > y) !== (yj > y)
      && x < (xj - xi) * (y - yi) / ((yj - yi) || Number.EPSILON) + xi
    if (intersects) inside = !inside
  }
  return inside
}

function uniqueFaces(faces: FaceRef[]): FaceRef[] {
  const seen = new Set<string>()
  return faces.filter((face) => {
    const key = `${face.axis}:${face.index}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function filledNaN(length: number) {
  const values = new Float32Array(length)
  values.fill(Number.NaN)
  return values
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum))
}

function featurePriority(feature: HydraulicFeature) {
  return feature.type === 'levee' ? 1
    : feature.type === 'simpleChannel' ? 2
      : feature.type === 'drainageOutlet' ? 3
        : feature.type === 'breach' ? 4 : 5
}

function featureName(feature: HydraulicFeature): string {
  return `${feature.name}（${{
    levee: '堤防', simpleChannel: '简化河道', engineeringChannel: '断面河道',
    culvert: '涵洞', bridge: '桥梁', drainageOutlet: '排水口', breach: '溃口',
  }[feature.type]}）`
}
