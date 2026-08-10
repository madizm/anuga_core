import type { Map as MapLibreMap } from 'maplibre-gl'
import type { GridCorners, GridRange, SimulationGrid } from './simulationGrid'
import {
  cellId,
  gridBoundaryLngLat,
  lngLatToGridUv,
} from './simulationGrid'

export type GridField =
  | 'elevation'
  | 'buildingFraction'
  | 'manningLow'
  | 'manningMiddle'
  | 'manningHigh'

export interface GridTileDescriptor {
  id: string
  rowStart: number
  rowStop: number
  columnStart: number
  columnStop: number
  cellCount: number
  demColumns: number
  topologyUrl: string
  fieldUrl: string
}

export interface GridManifest {
  version: 1
  tileSize: number
  demRows: number
  demColumns: number
  rowStart: number
  rowStop: number
  columnStart: number
  columnStop: number
  corners: GridCorners
  fields: GridField[]
  tiles: GridTileDescriptor[]
}

export interface GridTile {
  readonly descriptor: GridTileDescriptor
  readonly cellIndices: Uint32Array
  readonly fields: Partial<Record<GridField, Float32Array>>
}

const HEADER_BYTES = 32
const FIELD_CODES: Record<string, GridField | undefined> = {
  1: 'elevation',
  2: 'buildingFraction',
  3: 'manningLow',
  4: 'manningMiddle',
  5: 'manningHigh',
}

export function parseGridTile(
  buffer: ArrayBuffer, descriptor: GridTileDescriptor, expectedField: 'topology',
): GridTile
export function parseGridTile(
  buffer: ArrayBuffer, descriptor: GridTileDescriptor, expectedField: GridField,
): { field: GridField; values: Float32Array }
export function parseGridTile(
  buffer: ArrayBuffer, descriptor: GridTileDescriptor, expectedField: 'topology' | GridField,
): GridTile | { field: GridField; values: Float32Array } {
  if (buffer.byteLength < HEADER_BYTES) throw new Error('局部网格 tile 数据不完整')
  const view = new DataView(buffer)
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  )
  const version = view.getUint16(4, true)
  const headerBytes = view.getUint16(6, true)
  const fieldCode = view.getUint32(8, true)
  const rowStart = view.getUint32(12, true)
  const columnStart = view.getUint32(16, true)
  const rows = view.getUint32(20, true)
  const columns = view.getUint32(24, true)
  const cellCount = view.getUint32(28, true)
  if (
    magic !== 'BQGT' || version !== 1 || headerBytes !== HEADER_BYTES
    || rowStart !== descriptor.rowStart || columnStart !== descriptor.columnStart
    || rows !== descriptor.rowStop - descriptor.rowStart
    || columns !== descriptor.columnStop - descriptor.columnStart
    || cellCount !== descriptor.cellCount
  ) throw new Error('局部网格 tile 头部无效')
  if (expectedField === 'topology') {
    if (fieldCode !== 0) throw new Error('局部网格 tile 类型错误')
    const maskBytes = Math.ceil(rows * columns / 8)
    if (buffer.byteLength !== HEADER_BYTES + maskBytes) {
      throw new Error('局部网格拓扑 tile 数据不完整')
    }
    const indices = new Uint32Array(cellCount)
    const mask = new Uint8Array(buffer, HEADER_BYTES, maskBytes)
    let position = 0
    for (let local = 0; local < rows * columns; local += 1) {
      if ((mask[local >> 3] & (1 << (local & 7))) === 0) continue
      const row = descriptor.rowStart + Math.floor(local / columns)
      const column = descriptor.columnStart + (local % columns)
      indices[position] = row * descriptor.demColumns + column
      position += 1
    }
    if (position !== cellCount) throw new Error('局部网格拓扑 tile 单元数错误')
    return { descriptor, cellIndices: indices, fields: {} }
  }
  const field = FIELD_CODES[fieldCode]
  if (!field || field !== expectedField) throw new Error('局部网格字段 tile 类型错误')
  const expectedBytes = HEADER_BYTES + cellCount * 4
  if (buffer.byteLength !== expectedBytes) throw new Error('局部网格字段 tile 数据不完整')
  return {
    field,
    values: new Float32Array(buffer.slice(HEADER_BYTES)),
  }
}

export interface GridTileLoader {
  (url: string): Promise<ArrayBuffer>
}

/**
 * The map-facing grid interface. It keeps topology and field data tile-shaped;
 * only preview consumers use the full-area array assembler in GridTileStore.
 */
export class GridViewport {
  readonly cellCount: number
  private readonly tilesById: ReadonlyMap<string, GridTile>

  constructor(
    readonly geometry: SimulationGrid,
    readonly range: GridRange,
    readonly tiles: readonly GridTile[],
  ) {
    this.cellCount = tiles.reduce((total, tile) => total + tile.cellIndices.length, 0)
    this.tilesById = new Map(tiles.map((tile) => [tile.descriptor.id, tile]))
  }

  get tileIds(): readonly string[] {
    return this.tiles.map((tile) => tile.descriptor.id)
  }

  hasCellIndex(index: number): boolean {
    const row = Math.floor(index / this.geometry.demColumns)
    const column = index - row * this.geometry.demColumns
    const tile = this.tiles.find((candidate) => (
      row >= candidate.descriptor.rowStart && row < candidate.descriptor.rowStop
      && column >= candidate.descriptor.columnStart && column < candidate.descriptor.columnStop
    ))
    if (!tile) return false
    let low = 0
    let high = tile.cellIndices.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (tile.cellIndices[middle] < index) low = middle + 1
      else high = middle
    }
    return low < tile.cellIndices.length && tile.cellIndices[low] === index
  }

  cellAtLngLat(longitude: number, latitude: number): string | null {
    const uv = lngLatToGridUv(this.geometry, longitude, latitude)
    if (!uv || uv[0] < 0 || uv[0] >= 1 || uv[1] < 0 || uv[1] >= 1) return null
    const row = this.geometry.rowStart + Math.floor(
      uv[1] * (this.geometry.rowStop - this.geometry.rowStart),
    )
    const column = this.geometry.columnStart + Math.floor(
      uv[0] * (this.geometry.columnStop - this.geometry.columnStart),
    )
    const index = row * this.geometry.demColumns + column
    return this.hasCellIndex(index) ? cellId(row, column) : null
  }

  cellBounds(ids: Iterable<string>): [[number, number], [number, number]] | null {
    let west = Infinity
    let south = Infinity
    let east = -Infinity
    let north = -Infinity
    for (const id of ids) {
      const match = /^r(\d+)-c(\d+)$/.exec(id)
      if (!match) continue
      const row = Number(match[1])
      const column = Number(match[2])
      for (const point of [
        gridBoundaryLngLat(this.geometry, row, column),
        gridBoundaryLngLat(this.geometry, row, column + 1),
        gridBoundaryLngLat(this.geometry, row + 1, column),
        gridBoundaryLngLat(this.geometry, row + 1, column + 1),
      ]) {
        west = Math.min(west, point[0])
        south = Math.min(south, point[1])
        east = Math.max(east, point[0])
        north = Math.max(north, point[1])
      }
    }
    return Number.isFinite(west) ? [[west, south], [east, north]] : null
  }

  cellsInScreenBox(
    map: MapLibreMap,
    first: { x: number; y: number },
    second: { x: number; y: number },
  ): string[] {
    const left = Math.min(first.x, second.x)
    const right = Math.max(first.x, second.x)
    const top = Math.min(first.y, second.y)
    const bottom = Math.max(first.y, second.y)
    const result: string[] = []
    for (const tile of this.tilesById.values()) {
      for (const index of tile.cellIndices) {
        const row = Math.floor(index / this.geometry.demColumns)
        const column = index - row * this.geometry.demColumns
        const corners = [
          gridBoundaryLngLat(this.geometry, row, column),
          gridBoundaryLngLat(this.geometry, row, column + 1),
          gridBoundaryLngLat(this.geometry, row + 1, column),
          gridBoundaryLngLat(this.geometry, row + 1, column + 1),
        ].map((point) => map.project(point as [number, number]))
        const cellLeft = Math.min(...corners.map((point) => point.x))
        const cellRight = Math.max(...corners.map((point) => point.x))
        const cellTop = Math.min(...corners.map((point) => point.y))
        const cellBottom = Math.max(...corners.map((point) => point.y))
        if (cellRight >= left && cellLeft <= right && cellBottom >= top && cellTop <= bottom) {
          result.push(cellId(row, column))
        }
      }
    }
    return result
  }
}

export class GridTileStore {
  private readonly tiles = new Map<string, GridTile>()
  private readonly pending = new Map<string, Promise<GridTile>>()
  private readonly geometryGrid: SimulationGrid

  constructor(
    readonly manifest: GridManifest,
    private readonly load: GridTileLoader,
  ) {
    this.geometryGrid = this.createEmptyGrid()
  }

  tileIdsForRows(rowStart: number, rowStop: number, columnStart: number, columnStop: number): string[] {
    return this.manifest.tiles.filter((tile) => (
      tile.rowStop > rowStart && tile.rowStart < rowStop
      && tile.columnStop > columnStart && tile.columnStart < columnStop
    )).map((tile) => tile.id)
  }

  emptyGrid(): SimulationGrid {
    return this.geometryGrid
  }

  private createEmptyGrid(): SimulationGrid {
    return {
      cellCount: 0,
      demRows: this.manifest.demRows,
      demColumns: this.manifest.demColumns,
      rowStart: this.manifest.rowStart,
      rowStop: this.manifest.rowStop,
      columnStart: this.manifest.columnStart,
      columnStop: this.manifest.columnStop,
      corners: this.manifest.corners,
      cellIndices: new Uint32Array(),
      elevationM: new Float32Array(),
      buildingFraction: new Float32Array(),
      buildingDensityClass: new Float32Array(),
      manningLow: new Float32Array(),
      manningMiddle: new Float32Array(),
      manningHigh: new Float32Array(),
    }
  }

  emptyViewport(): GridViewport {
    return new GridViewport(this.emptyGrid(), {
      rowStart: this.manifest.rowStart,
      rowStop: this.manifest.rowStart,
      columnStart: this.manifest.columnStart,
      columnStop: this.manifest.columnStart,
    }, [])
  }

  get(tileId: string): GridTile | undefined {
    return this.tiles.get(tileId)
  }

  async loadTile(tileId: string, fields: readonly GridField[] = []): Promise<GridTile> {
    const descriptor = this.manifest.tiles.find((tile) => tile.id === tileId)
    if (!descriptor) throw new Error(`局部网格 tile 不存在：${tileId}`)
    let tile = this.tiles.get(tileId)
    if (!tile) tile = await this.loadTopology(descriptor)
    const missing = fields.filter((field) => tile?.fields[field] == null)
    if (missing.length === 0) return tile
    const results = await Promise.all(missing.map(async (field) => ({
      field,
      parsed: parseGridTile(
        await this.load(descriptor.fieldUrl.replace('{field}', field)), descriptor, field,
      ) as { field: GridField; values: Float32Array },
    })))
    const current = this.tiles.get(tileId) ?? tile
    const next: GridTile = {
      descriptor,
      cellIndices: current.cellIndices,
      fields: { ...current.fields },
    }
    for (const result of results) next.fields[result.field] = result.parsed.values
    this.tiles.set(tileId, next)
    return next
  }

  async loadViewport(
    rowStart: number, rowStop: number, columnStart: number, columnStop: number,
    fields: readonly GridField[] = [],
  ): Promise<GridViewport> {
    const range = { rowStart, rowStop, columnStart, columnStop }
    const tileIds = this.tileIdsForRows(rowStart, rowStop, columnStart, columnStop)
    const tiles = await Promise.all(tileIds.map((tileId) => this.loadTile(tileId, fields)))
    return new GridViewport(this.emptyGrid(), range, tiles)
  }

  async loadAll(fields: readonly GridField[] = []): Promise<SimulationGrid> {
    return this.assembleRegion(
      this.manifest.rowStart, this.manifest.rowStop,
      this.manifest.columnStart, this.manifest.columnStop, fields,
    )
  }

  private async assembleRegion(
    rowStart: number, rowStop: number, columnStart: number, columnStop: number,
    fields: readonly GridField[],
  ): Promise<SimulationGrid> {
    const tileIds = this.tileIdsForRows(rowStart, rowStop, columnStart, columnStop)
    const tiles = await Promise.all(tileIds.map((tileId) => this.loadTile(tileId, fields)))
    const entries = tiles.flatMap((tile) => Array.from(tile.cellIndices, (index, position) => ({
      index,
      position,
      tile,
    }))).sort((left, right) => left.index - right.index)
    const values = (field: GridField) => {
      const result = new Float32Array(entries.length)
      result.fill(Number.NaN)
      for (let index = 0; index < entries.length; index += 1) {
        const source = entries[index].tile.fields[field]
        if (source) result[index] = source[entries[index].position]
      }
      return result
    }
    return {
      cellCount: entries.length,
      demRows: this.manifest.demRows,
      demColumns: this.manifest.demColumns,
      rowStart: this.manifest.rowStart,
      rowStop: this.manifest.rowStop,
      columnStart: this.manifest.columnStart,
      columnStop: this.manifest.columnStop,
      corners: this.manifest.corners,
      cellIndices: Uint32Array.from(entries, (entry) => entry.index),
      elevationM: values('elevation'),
      buildingFraction: values('buildingFraction'),
      buildingDensityClass: new Float32Array(entries.length).fill(Number.NaN),
      manningLow: values('manningLow'),
      manningMiddle: values('manningMiddle'),
      manningHigh: values('manningHigh'),
    }
  }

  private async loadTopology(descriptor: GridTileDescriptor): Promise<GridTile> {
    const cached = this.tiles.get(descriptor.id)
    if (cached) return cached
    const existing = this.pending.get(descriptor.id)
    if (existing) return existing
    const request = this.load(descriptor.topologyUrl).then((buffer) => {
      const tile = parseGridTile(buffer, descriptor, 'topology') as GridTile
      this.tiles.set(descriptor.id, tile)
      this.pending.delete(descriptor.id)
      return tile
    }, (error) => {
      this.pending.delete(descriptor.id)
      throw error
    })
    this.pending.set(descriptor.id, request)
    return request
  }
}
