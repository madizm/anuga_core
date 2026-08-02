import type { FeatureCollection, LineString, Point, Polygon } from 'geojson'
import type {
  EngineeringChannelFeature, HydraulicFeature, Position, SimulationArea,
} from '../api/types'

let fallbackIdSequence = 0

function randomIdToken(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID().slice(0, 8)
  }

  const bytes = new Uint8Array(4)
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
  } else {
    fallbackIdSequence = (fallbackIdSequence + 1) >>> 0
    new DataView(bytes.buffer).setUint32(
      0, (Date.now() + fallbackIdSequence) >>> 0,
    )
  }
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

export type HydraulicDrawMode = 'levee' | 'simpleChannel' | 'engineeringChannel'
  | 'culvert' | 'bridge' | 'drainageOutlet' | 'breach'

export function createHydraulicFeature(
  mode: HydraulicDrawMode,
  geometry: LineString | Polygon | Point,
  area: SimulationArea,
  existing: HydraulicFeature[],
): HydraulicFeature {
  const sequence = existing.filter((feature) => feature.type === mode).length + 1
  const id = `${mode}-${randomIdToken()}`
  const common = { id, enabled: true }
  if (mode === 'levee' && geometry.type === 'LineString') return {
    ...common,
    type: 'levee',
    name: `堤防 ${sequence}`,
    geometry: lineGeometry(geometry),
    crestMode: 'relative',
    heightAboveGroundM: 2,
    qFactor: 1,
  }
  if (mode === 'simpleChannel' && geometry.type === 'Polygon') return {
    ...common,
    type: 'simpleChannel',
    name: `简化河道 ${sequence}`,
    geometry: polygonGeometry(geometry),
    elevationMode: 'lowerBy',
    depthM: 2,
    manningN: 0.03,
    maxTriangleAreaM2: Math.max(5, area.cellSizeM ** 2 / 8),
  }
  if (mode === 'engineeringChannel' && geometry.type === 'LineString') {
    const length = lineLengthM(geometry.coordinates as Position[])
    return {
      ...common,
      type: 'engineeringChannel',
      name: `断面河道 ${sequence}`,
      geometry: lineGeometry(geometry),
      bankHeightM: 3,
      manningN: 0.03,
      maxTriangleAreaM2: Math.max(5, area.cellSizeM ** 2 / 8),
      crossSections: [
        {
          distanceM: 0,
          bedElevationM: area.elevationM.minimum - 1,
          bottomWidthM: area.cellSizeM,
          sideSlope: 2,
        },
        {
          distanceM: Math.max(1, Math.floor(length)),
          bedElevationM: area.elevationM.minimum - 1.5,
          bottomWidthM: area.cellSizeM,
          sideSlope: 2,
        },
      ],
    }
  }
  if (mode === 'culvert' && geometry.type === 'LineString') return {
    ...common,
    type: 'culvert',
    name: `箱涵 ${sequence}`,
    geometry: lineGeometry(geometry),
    shape: 'box',
    widthM: 2,
    heightM: 2,
    barrels: 1,
    blockage: 0,
    losses: 1.5,
    manningN: 0.013,
  }
  if (mode === 'bridge' && geometry.type === 'LineString') return {
    ...common,
    type: 'bridge',
    name: `桥梁 / 闸孔 ${sequence}`,
    geometry: lineGeometry(geometry),
    widthM: 10,
    heightM: 3,
    leftSideSlope: 0,
    rightSideSlope: 0,
    blockage: 0,
    losses: 1,
    manningN: 0.03,
  }
  if (mode === 'drainageOutlet' && geometry.type === 'Point') return {
    ...common,
    type: 'drainageOutlet',
    name: `排水口 ${sequence}`,
    geometry: {
      type: 'Point',
      coordinates: [...geometry.coordinates] as Position,
    },
    capacityM3s: 0.5,
    intakeRadiusM: area.cellSizeM,
    fullCapacityDepthM: 0.3,
    blockage: 0,
  }
  if (mode === 'breach' && geometry.type === 'Point') {
    const levee = existing.find((feature) => feature.type === 'levee')
    if (!levee) throw new Error('请先绘制一条堤防')
    return {
      ...common,
      type: 'breach',
      name: `堤防缺口 ${sequence}`,
      leveeId: levee.id,
      geometry: {
        type: 'Point',
        coordinates: [...geometry.coordinates] as Position,
      },
      widthM: area.cellSizeM,
      crestElevationM: area.elevationM.mean,
    }
  }
  throw new Error(`绘制几何与 ${mode} 类型不匹配`)
}

export function lineLengthM(coordinates: Position[]): number {
  return coordinates.slice(1).reduce((total, coordinate, index) => (
    total + haversineM(coordinates[index], coordinate)
  ), 0)
}

function lineGeometry(geometry: LineString) {
  return {
    type: 'LineString' as const,
    coordinates: geometry.coordinates.map((coordinate) => (
      [Number(coordinate[0]), Number(coordinate[1])] as Position
    )),
  }
}

function polygonGeometry(geometry: Polygon) {
  return {
    type: 'Polygon' as const,
    coordinates: geometry.coordinates.map((ring) => ring.map((coordinate) => (
      [Number(coordinate[0]), Number(coordinate[1])] as Position
    ))),
  }
}

export function engineeringChannelSectionOverlay(
  channel: EngineeringChannelFeature,
  activeIndex: number,
): FeatureCollection {
  const coordinates = channel.geometry.coordinates
  const features: FeatureCollection['features'] = []
  channel.crossSections.forEach((section, index) => {
    const location = pointAndDirectionAtDistance(coordinates, section.distanceM)
    if (!location) return
    const active = index === activeIndex
    const halfWidthM = section.bottomWidthM / 2
      + section.sideSlope * channel.bankHeightM
    const latitudeRadians = location.point[1] * Math.PI / 180
    const metersPerLongitudeDegree = 111_320 * Math.cos(latitudeRadians)
    const metersPerLatitudeDegree = 110_540
    const east = (location.next[0] - location.previous[0]) * metersPerLongitudeDegree
    const north = (location.next[1] - location.previous[1]) * metersPerLatitudeDegree
    const magnitude = Math.hypot(east, north) || 1
    const perpendicularEast = -north / magnitude * halfWidthM
    const perpendicularNorth = east / magnitude * halfWidthM
    const offset = (sign: number): Position => [
      location.point[0] + sign * perpendicularEast / metersPerLongitudeDegree,
      location.point[1] + sign * perpendicularNorth / metersPerLatitudeDegree,
    ]
    features.push({
      type: 'Feature',
      properties: { active, index, distanceM: section.distanceM, kind: 'section-line' },
      geometry: { type: 'LineString', coordinates: [offset(-1), offset(1)] },
    }, {
      type: 'Feature',
      properties: { active, index, distanceM: section.distanceM, kind: 'section-point' },
      geometry: { type: 'Point', coordinates: location.point },
    })
  })
  return { type: 'FeatureCollection', features }
}

function pointAndDirectionAtDistance(
  coordinates: Position[],
  requestedDistanceM: number,
): { point: Position; previous: Position; next: Position } | null {
  if (coordinates.length < 2) return null
  const totalLength = lineLengthM(coordinates)
  const distanceM = Math.min(Math.max(0, requestedDistanceM), totalLength)
  let traversed = 0
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1]
    const next = coordinates[index]
    const segmentLength = haversineM(previous, next)
    if (traversed + segmentLength >= distanceM || index === coordinates.length - 1) {
      const fraction = segmentLength === 0 ? 0
        : Math.min(1, Math.max(0, (distanceM - traversed) / segmentLength))
      return {
        point: [
          previous[0] + (next[0] - previous[0]) * fraction,
          previous[1] + (next[1] - previous[1]) * fraction,
        ],
        previous,
        next,
      }
    }
    traversed += segmentLength
  }
  return null
}

function haversineM(first: Position, second: Position): number {
  const radians = Math.PI / 180
  const latitude1 = first[1] * radians
  const latitude2 = second[1] * radians
  const deltaLatitude = (second[1] - first[1]) * radians
  const deltaLongitude = (second[0] - first[0]) * radians
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2)
    * Math.sin(deltaLongitude / 2) ** 2
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
