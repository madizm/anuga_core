import type { LngLatLike, Map } from 'maplibre-gl'

export type GridCorners = readonly [
  readonly [number, number], readonly [number, number],
  readonly [number, number], readonly [number, number],
]

export interface SimulationGrid {
  cellCount: number
  demRows: number
  demColumns: number
  rowStart: number
  rowStop: number
  columnStart: number
  columnStop: number
  corners: GridCorners
  cellIndices: Uint32Array
  elevationM: Float32Array
  buildingFraction: Float32Array
  buildingDensityClass: Float32Array
  manningLow: Float32Array
  manningMiddle: Float32Array
  manningHigh: Float32Array
}


export function gridUvToLngLat(grid: SimulationGrid, u: number, v: number): [number, number] {
  const [nw, ne, sw, se] = grid.corners
  const northWeight = 1 - v
  const westWeight = 1 - u
  return [
    nw[0] * westWeight * northWeight + ne[0] * u * northWeight
      + sw[0] * westWeight * v + se[0] * u * v,
    nw[1] * westWeight * northWeight + ne[1] * u * northWeight
      + sw[1] * westWeight * v + se[1] * u * v,
  ]
}

export function gridBoundaryLngLat(
  grid: SimulationGrid, row: number, column: number,
): [number, number] {
  return gridUvToLngLat(
    grid,
    (column - grid.columnStart) / (grid.columnStop - grid.columnStart),
    (row - grid.rowStart) / (grid.rowStop - grid.rowStart),
  )
}

export function lngLatToGridUv(
  grid: SimulationGrid, longitude: number, latitude: number,
): [number, number] | null {
  const [nw, ne, sw, se] = grid.corners
  let u = (longitude - nw[0]) / (ne[0] - nw[0] || 1)
  let v = (latitude - nw[1]) / (sw[1] - nw[1] || 1)
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const [x, y] = gridUvToLngLat(grid, u, v)
    const dxdu = (ne[0] - nw[0]) * (1 - v) + (se[0] - sw[0]) * v
    const dxdv = (sw[0] - nw[0]) * (1 - u) + (se[0] - ne[0]) * u
    const dydu = (ne[1] - nw[1]) * (1 - v) + (se[1] - sw[1]) * v
    const dydv = (sw[1] - nw[1]) * (1 - u) + (se[1] - ne[1]) * u
    const determinant = dxdu * dydv - dxdv * dydu
    if (Math.abs(determinant) < 1e-18) return null
    const errorX = x - longitude
    const errorY = y - latitude
    u -= (errorX * dydv - errorY * dxdv) / determinant
    v -= (dxdu * errorY - dydu * errorX) / determinant
  }
  return Number.isFinite(u) && Number.isFinite(v) ? [u, v] : null
}

export function findCellPosition(grid: SimulationGrid, cellIndex: number): number {
  let low = 0
  let high = grid.cellIndices.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (grid.cellIndices[middle] < cellIndex) low = middle + 1
    else high = middle
  }
  return low < grid.cellIndices.length && grid.cellIndices[low] === cellIndex ? low : -1
}

export function cellId(row: number, column: number): string {
  return `r${String(row).padStart(4, '0')}-c${String(column).padStart(4, '0')}`
}

export function parseCellId(value: string): [number, number] | null {
  const match = /^r(\d{4,})-c(\d{4,})$/.exec(value)
  return match ? [Number(match[1]), Number(match[2])] : null
}

export interface GridRange {
  rowStart: number
  rowStop: number
  columnStart: number
  columnStop: number
}

export function gridViewportRange(map: Map, grid: SimulationGrid): GridRange {
  const bounds = map.getBounds()
  const points = [
    bounds.getNorthWest(), bounds.getNorthEast(),
    bounds.getSouthWest(), bounds.getSouthEast(),
  ].map((point) => lngLatToGridUv(grid, point.lng, point.lat)).filter(
    (value): value is [number, number] => value != null,
  )
  if (points.length === 0) return {
    rowStart: grid.rowStart, rowStop: grid.rowStop,
    columnStart: grid.columnStart, columnStop: grid.columnStop,
  }
  const rows = points.map((point) => grid.rowStart + point[1] * (grid.rowStop - grid.rowStart))
  const columns = points.map((point) => grid.columnStart + point[0] * (grid.columnStop - grid.columnStart))
  return {
    rowStart: Math.max(grid.rowStart, Math.floor(Math.min(...rows)) - 1),
    rowStop: Math.min(grid.rowStop, Math.ceil(Math.max(...rows)) + 1),
    columnStart: Math.max(grid.columnStart, Math.floor(Math.min(...columns)) - 1),
    columnStop: Math.min(grid.columnStop, Math.ceil(Math.max(...columns)) + 1),
  }
}

export function cellAtLngLat(
  grid: SimulationGrid, longitude: number, latitude: number,
): string | null {
  const uv = lngLatToGridUv(grid, longitude, latitude)
  if (!uv || uv[0] < 0 || uv[0] >= 1 || uv[1] < 0 || uv[1] >= 1) return null
  const row = grid.rowStart + Math.floor(uv[1] * (grid.rowStop - grid.rowStart))
  const column = grid.columnStart + Math.floor(uv[0] * (grid.columnStop - grid.columnStart))
  return findCellPosition(grid, row * grid.demColumns + column) >= 0 ? cellId(row, column) : null
}

export function cellBounds(
  grid: SimulationGrid, ids: Iterable<string>,
): [[number, number], [number, number]] | null {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const id of ids) {
    const parsed = parseCellId(id)
    if (!parsed) continue
    const [row, column] = parsed
    for (const point of [
      gridBoundaryLngLat(grid, row, column),
      gridBoundaryLngLat(grid, row, column + 1),
      gridBoundaryLngLat(grid, row + 1, column),
      gridBoundaryLngLat(grid, row + 1, column + 1),
    ]) {
      west = Math.min(west, point[0]); south = Math.min(south, point[1])
      east = Math.max(east, point[0]); north = Math.max(north, point[1])
    }
  }
  return Number.isFinite(west) ? [[west, south], [east, north]] : null
}

export function cellsInScreenBox(
  map: Map, grid: SimulationGrid, first: { x: number; y: number }, second: { x: number; y: number },
): string[] {
  const left = Math.min(first.x, second.x)
  const right = Math.max(first.x, second.x)
  const top = Math.min(first.y, second.y)
  const bottom = Math.max(first.y, second.y)
  const result: string[] = []
  for (const index of grid.cellIndices) {
    const row = Math.floor(index / grid.demColumns)
    const column = index - row * grid.demColumns
    const corners = [
      gridBoundaryLngLat(grid, row, column),
      gridBoundaryLngLat(grid, row, column + 1),
      gridBoundaryLngLat(grid, row + 1, column),
      gridBoundaryLngLat(grid, row + 1, column + 1),
    ].map((point) => map.project(point as LngLatLike))
    const cellLeft = Math.min(...corners.map((point) => point.x))
    const cellRight = Math.max(...corners.map((point) => point.x))
    const cellTop = Math.min(...corners.map((point) => point.y))
    const cellBottom = Math.max(...corners.map((point) => point.y))
    if (cellRight >= left && cellLeft <= right && cellBottom >= top && cellTop <= bottom) {
      result.push(cellId(row, column))
    }
  }
  return result
}
