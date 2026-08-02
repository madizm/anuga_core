import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map,
} from 'maplibre-gl'
import type { FrictionScenario } from '../api/types'
import {
  gridBoundaryLngLat,
  parseCellId,
  type SimulationGrid,
} from './simulationGrid'

const STRIDE_FLOATS = 10
const VERTEX_SHADER = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
layout(location=0) in vec3 a_position;
layout(location=1) in float a_building;
layout(location=2) in vec3 a_manning;
layout(location=3) in vec3 a_selection;
out float v_building;
out vec3 v_manning;
out vec3 v_selection;
void main() {
  gl_Position = u_matrix * vec4(a_position, 1.0);
  v_building = a_building;
  v_manning = a_manning;
  v_selection = a_selection;
}`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform int u_mode;
uniform int u_friction;
uniform vec2 u_manning_range;
uniform float u_line_alpha;
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
    color = selected ? vec4(0.91, 0.99, 1.0, 0.95) : vec4(0.29, 0.42, 0.46, u_line_alpha);
  }
}`

const MANNING_RANGES: Record<FrictionScenario, [number, number]> = {
  low: [0.03, 0.1], middle: [0.04, 0.16], high: [0.05, 0.2],
}

interface GridMesh {
  vertices: Float32Array
  triangles: Uint32Array
  lines: Uint32Array
}

interface Resources {
  program: WebGLProgram
  vertexArray: WebGLVertexArrayObject
  vertexBuffer: WebGLBuffer
  triangleBuffer: WebGLBuffer
  lineBuffer: WebGLBuffer
  matrix: WebGLUniformLocation
  mode: WebGLUniformLocation
  friction: WebGLUniformLocation
  manningRange: WebGLUniformLocation
  lineAlpha: WebGLUniformLocation
}

function colorComponents(value: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value)
  if (!match) return [0.42, 0.94, 1]
  const packed = Number.parseInt(match[1], 16)
  return [((packed >> 16) & 255) / 255, ((packed >> 8) & 255) / 255, (packed & 255) / 255]
}

export function buildSimulationGridMesh(
  map: Map, grid: SimulationGrid, terrainEnabled: boolean,
): GridMesh {
  const vertices = new Float32Array(grid.cellCount * 4 * STRIDE_FLOATS)
  const triangles = new Uint32Array(grid.cellCount * 6)
  const lines = new Uint32Array(grid.cellCount * 8)
  const projectedVertices = new globalThis.Map<number, [number, number, number]>()
  for (let position = 0; position < grid.cellCount; position += 1) {
    const index = grid.cellIndices[position]
    const row = Math.floor(index / grid.demColumns)
    const column = index - row * grid.demColumns
    const points = [
      gridBoundaryLngLat(grid, row, column),
      gridBoundaryLngLat(grid, row + 1, column),
      gridBoundaryLngLat(grid, row, column + 1),
      gridBoundaryLngLat(grid, row + 1, column + 1),
    ]
    for (let corner = 0; corner < 4; corner += 1) {
      const vertexRow = row + (corner & 1)
      const vertexColumn = column + (corner >> 1)
      const vertexKey = vertexRow * (grid.demColumns + 1) + vertexColumn
      let projected = projectedVertices.get(vertexKey)
      if (!projected) {
        const elevation = terrainEnabled
          ? (map.queryTerrainElevation(points[corner]) ?? grid.elevationM[position]) + 0.35
          : 0
        const mercator = MercatorCoordinate.fromLngLat(points[corner], elevation)
        projected = [mercator.x, mercator.y, mercator.z]
        projectedVertices.set(vertexKey, projected)
      }
      const offset = (position * 4 + corner) * STRIDE_FLOATS
      vertices[offset] = projected[0]
      vertices[offset + 1] = projected[1]
      vertices[offset + 2] = projected[2]
      vertices[offset + 3] = grid.buildingFraction[position]
      vertices[offset + 4] = grid.manningLow[position]
      vertices[offset + 5] = grid.manningMiddle[position]
      vertices[offset + 6] = grid.manningHigh[position]
    }
    const vertex = position * 4
    triangles.set([vertex, vertex + 2, vertex + 1, vertex + 2, vertex + 3, vertex + 1], position * 6)
    lines.set([
      vertex, vertex + 1, vertex + 1, vertex + 3,
      vertex + 3, vertex + 2, vertex + 2, vertex,
    ], position * 8)
  }
  return { vertices, triangles, lines }
}

export class SimulationGridLayer implements CustomLayerInterface {
  readonly id = 'model-grid'
  readonly type = 'custom' as const
  readonly renderingMode = '3d' as const
  private gl: WebGL2RenderingContext | null = null
  private resources: Resources | null = null
  private mesh: GridMesh | null = null
  private grid: SimulationGrid | null = null
  private terrainEnabled = false
  private friction: FrictionScenario = 'middle'
  private visibility = { grid: true, buildings: false, manning: false }
  private selections = new globalThis.Map<string, string>()

  constructor(private readonly map: Map) {}

  onAdd(_map: Map, context: WebGLRenderingContext | WebGL2RenderingContext) {
    if (!(context instanceof WebGL2RenderingContext)) throw new Error('局部网格需要 WebGL2')
    this.gl = context
    const program = createProgram(context, VERTEX_SHADER, FRAGMENT_SHADER)
    const vertexArray = required(context.createVertexArray(), 'vertex array')
    const vertexBuffer = required(context.createBuffer(), 'vertex buffer')
    const triangleBuffer = required(context.createBuffer(), 'triangle buffer')
    const lineBuffer = required(context.createBuffer(), 'line buffer')
    context.bindVertexArray(vertexArray)
    context.bindBuffer(context.ARRAY_BUFFER, vertexBuffer)
    const stride = STRIDE_FLOATS * 4
    context.enableVertexAttribArray(0); context.vertexAttribPointer(0, 3, context.FLOAT, false, stride, 0)
    context.enableVertexAttribArray(1); context.vertexAttribPointer(1, 1, context.FLOAT, false, stride, 3 * 4)
    context.enableVertexAttribArray(2); context.vertexAttribPointer(2, 3, context.FLOAT, false, stride, 4 * 4)
    context.enableVertexAttribArray(3); context.vertexAttribPointer(3, 3, context.FLOAT, false, stride, 7 * 4)
    this.resources = {
      program, vertexArray, vertexBuffer, triangleBuffer, lineBuffer,
      matrix: uniform(context, program, 'u_matrix'),
      mode: uniform(context, program, 'u_mode'),
      friction: uniform(context, program, 'u_friction'),
      manningRange: uniform(context, program, 'u_manning_range'),
      lineAlpha: uniform(context, program, 'u_line_alpha'),
    }
    if (this.grid) this.uploadMesh()
  }

  onRemove() {
    const gl = this.gl
    const resources = this.resources
    if (gl && resources) {
      gl.deleteBuffer(resources.vertexBuffer); gl.deleteBuffer(resources.triangleBuffer)
      gl.deleteBuffer(resources.lineBuffer); gl.deleteVertexArray(resources.vertexArray)
      gl.deleteProgram(resources.program)
    }
    this.resources = null
    this.gl = null
  }

  setGrid(grid: SimulationGrid | null) {
    this.grid = grid
    this.uploadMesh()
  }

  setTerrainEnabled(enabled: boolean) {
    if (this.terrainEnabled === enabled) return
    this.terrainEnabled = enabled
    this.uploadMesh()
  }

  refreshTerrain() {
    if (this.terrainEnabled) this.uploadMesh()
  }

  setFriction(value: FrictionScenario) {
    this.friction = value
    this.map.triggerRepaint()
  }

  setVisibility(value: { grid: boolean; buildings: boolean; manning: boolean }) {
    this.visibility = value
    this.map.triggerRepaint()
  }

  setSelections(value: globalThis.Map<string, string>) {
    this.selections = value
    if (!this.mesh || !this.grid) return
    for (let position = 0; position < this.grid.cellCount; position += 1) {
      const index = this.grid.cellIndices[position]
      const row = Math.floor(index / this.grid.demColumns)
      const id = `r${String(row).padStart(4, '0')}-c${String(index - row * this.grid.demColumns).padStart(4, '0')}`
      const color = value.get(id)
      const rgb = color ? colorComponents(color) : [0, 0, 0]
      for (let corner = 0; corner < 4; corner += 1) {
        const offset = (position * 4 + corner) * STRIDE_FLOATS + 7
        this.mesh.vertices[offset] = rgb[0]
        this.mesh.vertices[offset + 1] = rgb[1]
        this.mesh.vertices[offset + 2] = rgb[2]
      }
    }
    const gl = this.gl
    const resources = this.resources
    if (gl && resources) {
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.vertexBuffer)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.mesh.vertices)
    }
    this.map.triggerRepaint()
  }

  private uploadMesh() {
    if (!this.grid) {
      this.mesh = null
      this.map.triggerRepaint()
      return
    }
    this.mesh = buildSimulationGridMesh(this.map, this.grid, this.terrainEnabled)
    const gl = this.gl
    const resources = this.resources
    if (!gl || !resources) return
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh.vertices, gl.DYNAMIC_DRAW)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, resources.triangleBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.mesh.triangles, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, resources.lineBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.mesh.lines, gl.STATIC_DRAW)
    this.setSelections(this.selections)
  }

  render(
    context: WebGLRenderingContext | WebGL2RenderingContext,
    options: CustomRenderMethodInput,
  ) {
    const gl = context as WebGL2RenderingContext
    const resources = this.resources
    const mesh = this.mesh
    if (!resources || !mesh) return
    gl.useProgram(resources.program)
    gl.bindVertexArray(resources.vertexArray)
    gl.uniformMatrix4fv(resources.matrix, false, options.defaultProjectionData.mainMatrix)
    gl.uniform1i(resources.friction, this.friction === 'low' ? 0 : this.friction === 'middle' ? 1 : 2)
    const range = MANNING_RANGES[this.friction]
    gl.uniform2f(resources.manningRange, range[0], range[1])
    gl.uniform1f(resources.lineAlpha, Math.max(0.15, Math.min(0.75, (this.map.getZoom() - 13) / 3 * 0.5 + 0.25)))
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.depthMask(false)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, resources.triangleBuffer)
    if (this.visibility.manning) this.draw(gl, resources, 2, mesh.triangles.length, gl.TRIANGLES)
    if (this.visibility.buildings) this.draw(gl, resources, 1, mesh.triangles.length, gl.TRIANGLES)
    if (this.visibility.grid) {
      this.draw(gl, resources, 0, mesh.triangles.length, gl.TRIANGLES)
      if (this.map.getZoom() >= 13) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, resources.lineBuffer)
        this.draw(gl, resources, 3, mesh.lines.length, gl.LINES)
      }
    }
    gl.depthMask(true)
    gl.bindVertexArray(null)
  }

  private draw(
    gl: WebGL2RenderingContext, resources: Resources, mode: number,
    count: number, primitive: number,
  ) {
    gl.uniform1i(resources.mode, mode)
    gl.drawElements(primitive, count, gl.UNSIGNED_INT, 0)
  }
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
    gl.shaderSource(shader, source); gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || 'unknown shader error'
      gl.deleteShader(shader); throw new Error(message)
    }
    return shader
  }
  const vertex = compile(gl.VERTEX_SHADER, vertexSource)
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource)
  const program = required(gl.createProgram(), 'program')
  gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program)
  gl.deleteShader(vertex); gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'unknown link error'
    gl.deleteProgram(program); throw new Error(message)
  }
  return program
}

// Retained as a named export for tests and selection adapters.
export { parseCellId }
