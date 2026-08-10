import type { Feature, FeatureCollection, LineString } from 'geojson'
import {
  gridBoundaryLngLat,
  type SimulationGrid,
} from './simulationGrid'

export interface ContourProperties {
  elevationM: number
  isMajor: boolean
  label: string
}

export interface ContourOptions {
  intervalM?: number
  majorIntervalM?: number
}

type GridPoint = readonly [number, number]
type Segment = { start: GridPoint; end: GridPoint }

const DEFAULT_INTERVAL_M = 5
const DEFAULT_MAJOR_INTERVAL_M = 25
const EPSILON = 1e-9

/** Build labelled GeoJSON contours from the selected DEM cells. */
export function buildContourFeatures(
  grid: SimulationGrid,
  {
    intervalM = DEFAULT_INTERVAL_M,
    majorIntervalM = DEFAULT_MAJOR_INTERVAL_M,
  }: ContourOptions = {},
): FeatureCollection<LineString, ContourProperties> {
  if (!Number.isFinite(intervalM) || intervalM <= 0) {
    throw new Error('等高距必须为正数')
  }
  if (!Number.isFinite(majorIntervalM) || majorIntervalM <= 0) {
    throw new Error('主等高距必须为正数')
  }

  const samples = new Map<number, number>()
  let minimum = Infinity
  let maximum = -Infinity
  for (let index = 0; index < grid.cellIndices.length; index += 1) {
    const elevation = grid.elevationM[index]
    if (!Number.isFinite(elevation)) continue
    samples.set(grid.cellIndices[index], elevation)
    minimum = Math.min(minimum, elevation)
    maximum = Math.max(maximum, elevation)
  }
  if (!Number.isFinite(minimum) || minimum >= maximum) {
    return { type: 'FeatureCollection', features: [] }
  }

  const features: Feature<LineString, ContourProperties>[] = []
  const firstLevel = Math.floor(minimum / intervalM) + 1
  const lastLevel = Math.ceil(maximum / intervalM) - 1
  for (let step = firstLevel; step <= lastLevel; step += 1) {
    const level = step * intervalM
    const segments = contourSegments(grid, samples, level)
    const lines = joinSegments(segments)
    const elevationM = Number(level.toFixed(6))
    const properties: ContourProperties = {
      elevationM,
      isMajor: Math.abs(level / majorIntervalM - Math.round(level / majorIntervalM)) < EPSILON,
      label: `${formatElevation(elevationM)} m`,
    }
    for (const line of lines) {
      if (line.length < 2) continue
      features.push({
        type: 'Feature',
        properties,
        geometry: {
          type: 'LineString',
          coordinates: line.map(([row, column]) => (
            gridBoundaryLngLat(grid, row, column)
          )),
        },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

function contourSegments(
  grid: SimulationGrid,
  samples: Map<number, number>,
  level: number,
): Segment[] {
  const segments: Segment[] = []
  for (let row = grid.rowStart; row < grid.rowStop - 1; row += 1) {
    for (let column = grid.columnStart; column < grid.columnStop - 1; column += 1) {
      const topLeft = samples.get(row * grid.demColumns + column)
      const topRight = samples.get(row * grid.demColumns + column + 1)
      const bottomRight = samples.get((row + 1) * grid.demColumns + column + 1)
      const bottomLeft = samples.get((row + 1) * grid.demColumns + column)
      if ([topLeft, topRight, bottomRight, bottomLeft].some((value) => value === undefined)) {
        continue
      }
      const values = [topLeft!, topRight!, bottomRight!, bottomLeft!]
      const mask = values.reduce(
        (result, value, index) => result | (value > level ? 1 << index : 0),
        0,
      )
      const edgePoints = new Map<number, GridPoint>()
      const edges: readonly [number, number, number, (fraction: number) => GridPoint][] = [
        [0, 1, 0, (fraction) => [row, column + fraction]],
        [1, 2, 1, (fraction) => [row + fraction, column + 1]],
        [3, 2, 2, (fraction) => [row + 1, column + fraction]],
        [0, 3, 3, (fraction) => [row + fraction, column]],
      ]
      for (const [first, second, edge, point] of edges) {
        const firstValue = values[first]
        const secondValue = values[second]
        if ((firstValue > level) === (secondValue > level) || firstValue === secondValue) continue
        const fraction = (level - firstValue) / (secondValue - firstValue)
        edgePoints.set(edge, point(fraction))
      }
      const pairings = CASE_EDGE_PAIRS[mask]
      for (let index = 0; index < pairings.length; index += 2) {
        const start = edgePoints.get(pairings[index])
        const end = edgePoints.get(pairings[index + 1])
        if (start && end) segments.push({ start, end })
      }
    }
  }
  return segments
}

const CASE_EDGE_PAIRS: readonly number[][] = [
  [], [3, 0], [0, 1], [3, 1], [1, 2],
  [3, 0, 1, 2], [0, 2], [3, 2], [2, 3], [0, 2],
  [0, 1, 2, 3], [1, 2], [1, 3], [0, 1], [3, 0], [],
]

function joinSegments(segments: Segment[]): GridPoint[][] {
  const remaining = segments.map((segment) => ({ ...segment, used: false }))
  const endpointSegments = new Map<string, number[]>()
  remaining.forEach((segment, index) => {
    for (const point of [segment.start, segment.end]) {
      const key = pointKey(point)
      endpointSegments.set(key, [...(endpointSegments.get(key) ?? []), index])
    }
  })

  const lines: GridPoint[][] = []
  for (let index = 0; index < remaining.length; index += 1) {
    if (remaining[index].used) continue
    remaining[index].used = true
    const line: GridPoint[] = [remaining[index].start, remaining[index].end]
    extendLine(line, remaining, endpointSegments, true)
    extendLine(line, remaining, endpointSegments, false)
    lines.push(line)
  }
  return lines
}

function extendLine(
  line: GridPoint[],
  segments: Array<Segment & { used: boolean }>,
  endpointSegments: Map<string, number[]>,
  forward: boolean,
) {
  while (true) {
    const anchor = forward ? line.at(-1)! : line[0]
    const nextIndex = (endpointSegments.get(pointKey(anchor)) ?? [])
      .find((index) => !segments[index].used)
    if (nextIndex === undefined) return
    const next = segments[nextIndex]
    segments[nextIndex].used = true
    const nextPoint = pointKey(next.start) === pointKey(anchor) ? next.end : next.start
    if (forward) line.push(nextPoint)
    else line.unshift(nextPoint)
  }
}

function pointKey(point: GridPoint): string {
  return `${point[0].toFixed(8)}:${point[1].toFixed(8)}`
}

function formatElevation(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
