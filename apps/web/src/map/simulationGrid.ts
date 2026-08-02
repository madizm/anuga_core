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

const HEADER_BYTES = 100
const PLANE_COUNT = 7

export function parseSimulationGrid(buffer: ArrayBuffer): SimulationGrid {
  if (buffer.byteLength < HEADER_BYTES) throw new Error('局部网格数据不完整')
  const view = new DataView(buffer)
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  )
  const version = view.getUint16(4, true)
  const headerBytes = view.getUint16(6, true)
  const cellCount = view.getUint32(8, true)
  if (magic !== 'BQSG' || version !== 1 || headerBytes !== HEADER_BYTES || cellCount === 0) {
    throw new Error('局部网格格式不受支持')
  }
  const expectedBytes = headerBytes + cellCount * PLANE_COUNT * 4
  if (buffer.byteLength !== expectedBytes) throw new Error('局部网格数据不完整')
  const values = Array.from({ length: 8 }, (_, index) => view.getFloat64(36 + index * 8, true))
  if (!values.every(Number.isFinite)) throw new Error('局部网格坐标无效')
  const planes: Array<Uint32Array | Float32Array> = []
  for (let plane = 0; plane < PLANE_COUNT; plane += 1) {
    const start = headerBytes + plane * cellCount * 4
    const bytes = buffer.slice(start, start + cellCount * 4)
    planes.push(plane === 0 ? new Uint32Array(bytes) : new Float32Array(bytes))
  }
  const grid: SimulationGrid = {
    cellCount,
    demRows: view.getUint32(12, true),
    demColumns: view.getUint32(16, true),
    rowStart: view.getUint32(20, true),
    rowStop: view.getUint32(24, true),
    columnStart: view.getUint32(28, true),
    columnStop: view.getUint32(32, true),
    corners: [
      [values[0], values[1]], [values[2], values[3]],
      [values[4], values[5]], [values[6], values[7]],
    ],
    cellIndices: planes[0] as Uint32Array,
    elevationM: planes[1] as Float32Array,
    buildingFraction: planes[2] as Float32Array,
    buildingDensityClass: planes[3] as Float32Array,
    manningLow: planes[4] as Float32Array,
    manningMiddle: planes[5] as Float32Array,
    manningHigh: planes[6] as Float32Array,
  }
  if (
    grid.demRows === 0 || grid.demColumns === 0
    || grid.rowStart >= grid.rowStop || grid.columnStart >= grid.columnStop
    || grid.rowStop > grid.demRows || grid.columnStop > grid.demColumns
  ) throw new Error('局部网格范围无效')
  for (let index = 0; index < cellCount; index += 1) {
    const cell = grid.cellIndices[index]
    if (cell >= grid.demRows * grid.demColumns || (index > 0 && cell <= grid.cellIndices[index - 1])) {
      throw new Error('局部网格索引无效')
    }
  }
  return grid
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
