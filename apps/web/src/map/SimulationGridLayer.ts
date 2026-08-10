import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map,
} from 'maplibre-gl'
import type { FrictionScenario } from '../api/types'
import type { GridTile, GridViewport } from './gridTiles'
import { gridViewportRange } from './simulationGrid'

const INSTANCE_STRIDE_FLOATS = 10
const INSTANCE_STRIDE_BYTES = INSTANCE_STRIDE_FLOATS * 4
const MAX_CACHED_TILE_BUFFERS = 32
const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])

const VERTEX_SHADER = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform vec4 u_grid;
uniform vec3 u_northwest;
uniform vec3 u_northeast;
uniform vec3 u_southwest;
uniform vec3 u_southeast;
uniform float u_meter_scale;
uniform bool u_terrain;
layout(location=0) in vec2 a_corner;
layout(location=1) in vec2 a_cell;
layout(location=2) in float a_elevation;
layout(location=3) in float a_building;
layout(location=4) in vec3 a_manning;
layout(location=5) in vec3 a_selection;
out vec2 v_corner;
out float v_building;
out vec3 v_manning;
out vec3 v_selection;
void main() {
  float u = (a_cell.y - u_grid.z + a_corner.x) / u_grid.w;
  float v = (a_cell.x - u_grid.x + a_corner.y) / u_grid.y;
  vec3 north = mix(u_northwest, u_northeast, u);
  vec3 south = mix(u_southwest, u_southeast, u);
  vec3 position = mix(north, south, v);
  if (u_terrain) position.z += max(a_elevation, 0.0) * u_meter_scale + 0.35 * u_meter_scale;
  gl_Position = u_matrix * vec4(position, 1.0);
  v_corner = a_corner;
  v_building = a_building;
  v_manning = a_manning;
  v_selection = a_selection;
}`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform int u_mode;
uniform int u_friction;
uniform vec2 u_manning_range;
uniform float u_line_width;
in vec2 v_corner;
in float v_building;
in vec3 v_manning;
in vec3 v_selection;
out vec4 color;
vec3 ramp(float value, vec3 low, vec3 middle, vec3 high) {
  return value < 0.5 ? mix(low, middle, value * 2.0) : mix(middle, high, (value - 0.5) * 2.0);
}
void main() {
  bool selected = dot(v_selection, v_selection) > 0.0001;
  if (u_mode == 0) {
    color = selected ? vec4(v_selection, 0.72) : vec4(0.075, 0.14, 0.17, 0.08);
  } else if (u_mode == 1) {
    if (!(v_building > 0.0)) discard;
    color = vec4(
      ramp(clamp(v_building, 0.0, 1.0), vec3(1.0, 0.88, 0.48), vec3(1.0, 0.54, 0.24), vec3(0.91, 0.28, 0.21)),
      mix(0.18, 0.9, clamp(v_building, 0.0, 1.0))
    );
  } else if (u_mode == 2) {
    float value = u_friction == 0 ? v_manning.x : (u_friction == 1 ? v_manning.y : v_manning.z);
    if (isnan(value)) discard;
    float normalized = clamp((value - u_manning_range.x) / (u_manning_range.y - u_manning_range.x), 0.0, 1.0);
    color = vec4(ramp(normalized, vec3(0.14, 0.46, 0.54), vec3(0.83, 0.71, 0.31), vec3(0.9, 0.33, 0.24)), 0.76);
  } else {
    float edge = min(min(v_corner.x, 1.0 - v_corner.x), min(v_corner.y, 1.0 - v_corner.y));
    if (edge > u_line_width) discard;
    color = selected ? vec4(0.91, 0.99, 1.0, 0.95) : vec4(0.29, 0.42, 0.46, 0.58);
  }
}`

const MANNING_RANGES: Record<FrictionScenario, [number, number]> = {
  low: [0.03, 0.1], middle: [0.04, 0.16], high: [0.05, 0.2],
}

interface GridInstances {
  values: Float32Array
  count: number
}

interface TileBuffer {
  tile: GridTile
  values: Float32Array
  count: number
  buffer: WebGLBuffer | null
  selectionRevision: number
}

interface Resources {
  program: WebGLProgram
  vertexArray: WebGLVertexArrayObject
  cornerBuffer: WebGLBuffer
  matrix: WebGLUniformLocation
  grid: WebGLUniformLocation
  corners: [WebGLUniformLocation, WebGLUniformLocation, WebGLUniformLocation, WebGLUniformLocation]
  meterScale: WebGLUniformLocation
  terrain: WebGLUniformLocation
  mode: WebGLUniformLocation
  friction: WebGLUniformLocation
  manningRange: WebGLUniformLocation
  lineWidth: WebGLUniformLocation
}

function colorComponents(value: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value)
  if (!match) return [0.42, 0.94, 1]
  const packed = Number.parseInt(match[1], 16)
  return [((packed >> 16) & 255) / 255, ((packed >> 8) & 255) / 255, (packed & 255) / 255]
}

/** Pack exactly one topology tile. No viewport-wide scan or sort is needed. */
export function buildSimulationGridInstances(
  tile: GridTile,
  selections: ReadonlyMap<string, string>,
): GridInstances {
  const positions: number[] = []
  const { descriptor, cellIndices, fields } = tile
  for (let position = 0; position < cellIndices.length; position += 1) {
    const index = cellIndices[position]
    const row = Math.floor(index / descriptor.demColumns)
    const column = index - row * descriptor.demColumns
    const id = `r${String(row).padStart(4, '0')}-c${String(column).padStart(4, '0')}`
    const selection = selections.get(id)
    const rgb = selection ? colorComponents(selection) : [0, 0, 0]
    positions.push(
      row,
      column,
      fields.elevation?.[position] ?? Number.NaN,
      fields.buildingFraction?.[position] ?? Number.NaN,
      fields.manningLow?.[position] ?? Number.NaN,
      fields.manningMiddle?.[position] ?? Number.NaN,
      fields.manningHigh?.[position] ?? Number.NaN,
      rgb[0], rgb[1], rgb[2],
    )
  }
  return {
    values: Float32Array.from(positions),
    count: positions.length / INSTANCE_STRIDE_FLOATS,
  }
}

export class SimulationGridLayer implements CustomLayerInterface {
  readonly id = 'model-grid'
  readonly type = 'custom' as const
  readonly renderingMode = '3d' as const
  private gl: WebGL2RenderingContext | null = null
  private resources: Resources | null = null
  private viewport: GridViewport | null = null
  private visibleTileIds: string[] = []
  private readonly tileBuffers = new globalThis.Map<string, TileBuffer>()
  private readonly pendingUploads = new Set<string>()
  private uploadFrame: number | null = null
  private terrainEnabled = false
  private friction: FrictionScenario = 'middle'
  private visibility = { grid: true, buildings: false, manning: false }
  private selections = new globalThis.Map<string, string>()
  private selectionRevision = 0
  private readonly refreshVisibleTiles = () => this.updateVisibleTiles()

  constructor(private readonly map: Map) {}

  onAdd(_map: Map, context: WebGLRenderingContext | WebGL2RenderingContext) {
    if (!(context instanceof WebGL2RenderingContext)) throw new Error('局部网格需要 WebGL2')
    this.gl = context
    const program = createProgram(context, VERTEX_SHADER, FRAGMENT_SHADER)
    const vertexArray = required(context.createVertexArray(), 'vertex array')
    const cornerBuffer = required(context.createBuffer(), 'corner buffer')
    context.bindVertexArray(vertexArray)
    context.bindBuffer(context.ARRAY_BUFFER, cornerBuffer)
    context.bufferData(context.ARRAY_BUFFER, QUAD, context.STATIC_DRAW)
    context.enableVertexAttribArray(0)
    context.vertexAttribPointer(0, 2, context.FLOAT, false, 0, 0)
    this.resources = {
      program, vertexArray, cornerBuffer,
      matrix: uniform(context, program, 'u_matrix'),
      grid: uniform(context, program, 'u_grid'),
      corners: [
        uniform(context, program, 'u_northwest'),
        uniform(context, program, 'u_northeast'),
        uniform(context, program, 'u_southwest'),
        uniform(context, program, 'u_southeast'),
      ],
      meterScale: uniform(context, program, 'u_meter_scale'),
      terrain: uniform(context, program, 'u_terrain'),
      mode: uniform(context, program, 'u_mode'),
      friction: uniform(context, program, 'u_friction'),
      manningRange: uniform(context, program, 'u_manning_range'),
      lineWidth: uniform(context, program, 'u_line_width'),
    }
    this.map.on('move', this.refreshVisibleTiles)
    this.map.on('moveend', this.refreshVisibleTiles)
    this.updateVisibleTiles()
    this.flushTileUploads()
  }

  onRemove() {
    this.map.off('move', this.refreshVisibleTiles)
    this.map.off('moveend', this.refreshVisibleTiles)
    const gl = this.gl
    const resources = this.resources
    if (this.uploadFrame !== null) cancelAnimationFrame(this.uploadFrame)
    this.uploadFrame = null
    this.pendingUploads.clear()
    if (gl && resources) {
      for (const tile of this.tileBuffers.values()) {
        if (tile.buffer) gl.deleteBuffer(tile.buffer)
      }
      gl.deleteBuffer(resources.cornerBuffer)
      gl.deleteVertexArray(resources.vertexArray)
      gl.deleteProgram(resources.program)
    }
    this.tileBuffers.clear()
    this.resources = null
    this.gl = null
  }

  setViewport(viewport: GridViewport | null) {
    this.viewport = viewport
    this.updateVisibleTiles()
  }

  setTerrainEnabled(enabled: boolean) {
    if (this.terrainEnabled === enabled) return
    this.terrainEnabled = enabled
    this.map.triggerRepaint()
  }

  refreshTerrain() {
    this.map.triggerRepaint()
  }

  setFriction(value: FrictionScenario) {
    if (this.friction === value) return
    this.friction = value
    this.map.triggerRepaint()
  }

  setVisibility(value: { grid: boolean; buildings: boolean; manning: boolean }) {
    this.visibility = value
    this.map.triggerRepaint()
  }

  setSelections(value: globalThis.Map<string, string>) {
    this.selections = value
    this.selectionRevision += 1
    this.updateVisibleTiles(true)
  }

  private updateVisibleTiles(force = false) {
    const viewport = this.viewport
    if (!viewport) {
      this.visibleTileIds = []
      this.map.triggerRepaint()
      return
    }
    const range = gridViewportRange(this.map, viewport.geometry)
    const nextIds = viewport.tiles.filter((tile) => (
      tile.descriptor.rowStop > range.rowStart && tile.descriptor.rowStart < range.rowStop
      && tile.descriptor.columnStop > range.columnStart && tile.descriptor.columnStart < range.columnStop
    )).map((tile) => tile.descriptor.id)
    const changed = force || nextIds.length !== this.visibleTileIds.length
      || nextIds.some((id, index) => id !== this.visibleTileIds[index])
    this.visibleTileIds = nextIds
    for (const tile of viewport.tiles) {
      if (this.visibleTileIds.includes(tile.descriptor.id)) this.ensureTileBuffer(tile)
    }
    if (this.tileBuffers.size > MAX_CACHED_TILE_BUFFERS) this.evictTileBuffers()
    if (changed || force) this.map.triggerRepaint()
  }

  private ensureTileBuffer(tile: GridTile) {
    const current = this.tileBuffers.get(tile.descriptor.id)
    if (current && current.tile === tile && current.selectionRevision === this.selectionRevision) return
    const instances = buildSimulationGridInstances(tile, this.selections)
    const next: TileBuffer = {
      tile,
      values: instances.values,
      count: instances.count,
      buffer: current?.buffer ?? null,
      selectionRevision: this.selectionRevision,
    }
    this.tileBuffers.set(tile.descriptor.id, next)
    this.scheduleTileUpload(tile.descriptor.id)
  }

  private scheduleTileUpload(tileId: string) {
    this.pendingUploads.add(tileId)
    if (this.uploadFrame !== null) return
    this.uploadFrame = requestAnimationFrame(() => {
      this.uploadFrame = null
      this.flushTileUploads()
    })
  }

  private flushTileUploads() {
    if (this.pendingUploads.size === 0 || !this.gl || !this.resources) return
    const tileIds = [...this.pendingUploads]
    this.pendingUploads.clear()
    for (const tileId of tileIds) {
      const tile = this.tileBuffers.get(tileId)
      if (tile) this.uploadTileBuffer(tile)
    }
    this.map.triggerRepaint()
  }

  private uploadTileBuffer(tile: TileBuffer) {
    const gl = this.gl
    const resources = this.resources
    if (!gl || !resources) return
    if (!tile.buffer) tile.buffer = required(gl.createBuffer(), 'instance buffer')
    gl.bindBuffer(gl.ARRAY_BUFFER, tile.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, tile.values, gl.DYNAMIC_DRAW)
  }

  private evictTileBuffers() {
    const gl = this.gl
    const visible = new Set(this.visibleTileIds)
    for (const [id, tile] of this.tileBuffers) {
      if (this.tileBuffers.size <= MAX_CACHED_TILE_BUFFERS) break
      if (visible.has(id)) continue
      if (gl && tile.buffer) gl.deleteBuffer(tile.buffer)
      this.tileBuffers.delete(id)
    }
  }

  render(
    context: WebGLRenderingContext | WebGL2RenderingContext,
    options: CustomRenderMethodInput,
  ) {
    const gl = context as WebGL2RenderingContext
    const resources = this.resources
    const viewport = this.viewport
    if (!resources || !viewport || this.visibleTileIds.length === 0) return
    gl.useProgram(resources.program)
    gl.bindVertexArray(resources.vertexArray)
    gl.uniformMatrix4fv(resources.matrix, false, options.defaultProjectionData.mainMatrix)
    const grid = viewport.geometry
    gl.uniform4f(
      resources.grid,
      grid.rowStart, grid.rowStop - grid.rowStart,
      grid.columnStart, grid.columnStop - grid.columnStart,
    )
    const projected = grid.corners.map((corner) => MercatorCoordinate.fromLngLat(corner as [number, number], 0))
    projected.forEach((corner, index) => {
      gl.uniform3f(resources.corners[index], corner.x, corner.y, corner.z)
    })
    const center = MercatorCoordinate.fromLngLat([
      grid.corners.reduce((sum, corner) => sum + corner[0], 0) / 4,
      grid.corners.reduce((sum, corner) => sum + corner[1], 0) / 4,
    ])
    gl.uniform1f(resources.meterScale, center.meterInMercatorCoordinateUnits())
    gl.uniform1i(resources.terrain, this.terrainEnabled ? 1 : 0)
    gl.uniform1i(resources.friction, this.friction === 'low' ? 0 : this.friction === 'middle' ? 1 : 2)
    const range = MANNING_RANGES[this.friction]
    gl.uniform2f(resources.manningRange, range[0], range[1])
    gl.uniform1f(resources.lineWidth, Math.max(0.012, 0.055 / 2 ** Math.max(0, this.map.getZoom() - 13)))
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.depthMask(false)
    for (const tileId of this.visibleTileIds) {
      const tile = this.tileBuffers.get(tileId)
      if (!tile?.buffer || tile.count === 0) continue
      this.bindInstanceAttributes(gl, tile.buffer)
      if (this.visibility.manning) this.draw(gl, resources, tile.count, 2)
      if (this.visibility.buildings) this.draw(gl, resources, tile.count, 1)
      if (this.visibility.grid) {
        this.draw(gl, resources, tile.count, 0)
        if (this.map.getZoom() >= 13) this.draw(gl, resources, tile.count, 3)
      }
    }
    gl.depthMask(true)
    gl.bindVertexArray(null)
  }

  private bindInstanceAttributes(gl: WebGL2RenderingContext, buffer: WebGLBuffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    attribute(gl, 1, 2, INSTANCE_STRIDE_BYTES, 0)
    attribute(gl, 2, 1, INSTANCE_STRIDE_BYTES, 2 * 4)
    attribute(gl, 3, 1, INSTANCE_STRIDE_BYTES, 3 * 4)
    attribute(gl, 4, 3, INSTANCE_STRIDE_BYTES, 4 * 4)
    attribute(gl, 5, 3, INSTANCE_STRIDE_BYTES, 7 * 4)
  }

  private draw(gl: WebGL2RenderingContext, resources: Resources, count: number, mode: number) {
    gl.uniform1i(resources.mode, mode)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count)
  }
}

function attribute(
  gl: WebGL2RenderingContext, location: number, size: number,
  stride: number, offset: number,
) {
  gl.enableVertexAttribArray(location)
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset)
  gl.vertexAttribDivisor(location, 1)
}

function required<T>(value: T | null, name: string): T {
  if (!value) throw new Error(`无法创建局部网格 ${name}`)
  return value
}

function uniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string) {
  return required(gl.getUniformLocation(program, name), `uniform ${name}`)
}

function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string) {
  const compile = (type: number, source: string) => {
    const shader = required(gl.createShader(type), 'shader')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || 'unknown shader error'
      gl.deleteShader(shader)
      throw new Error(message)
    }
    return shader
  }
  const vertex = compile(gl.VERTEX_SHADER, vertexSource)
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource)
  const program = required(gl.createProgram(), 'program')
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'unknown link error'
    gl.deleteProgram(program)
    throw new Error(message)
  }
  return program
}

export { parseCellId } from './simulationGrid'
