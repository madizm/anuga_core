import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map,
} from 'maplibre-gl'
import type { FlowField, ResultQuantity } from '../api/types'
import { waterRippleParams } from './waterRippleParams'
import { gridUvToLngLat } from './flowGrid'

const CROSSFADE_MS = 220

/**
 * Packs a flow field into RGBA texels for the ripple shader:
 * R = velocity u, G = velocity v, B = depth, A = wet flag (0/1).
 * Non-finite (dry) cells are zeroed; NaN never reaches the GPU because NaN
 * behaviour in texture sampling varies across drivers. Legacy v1 fields have
 * no depth plane: wet cells get depth 1 so the feather saturates and the wet
 * flag alone drives the boundary.
 */
export function packFieldPixels(field: FlowField): Float32Array {
  const cellCount = field.width * field.height
  const pixels = new Float32Array(cellCount * 4)
  for (let cell = 0; cell < cellCount; cell += 1) {
    const u = field.vectors[cell * 2]
    const v = field.vectors[cell * 2 + 1]
    const depth = field.depths ? field.depths[cell] : Number.NaN
    const velocityValid = Number.isFinite(u) && Number.isFinite(v)
    const wet = field.depths
      ? velocityValid && Number.isFinite(depth)
      : velocityValid
    if (!wet) continue
    pixels[cell * 4] = u
    pixels[cell * 4 + 1] = v
    pixels[cell * 4 + 2] = field.depths ? depth : 1
    pixels[cell * 4 + 3] = 1
  }
  return pixels
}

/** Approximate ground size of one grid cell in metres, [east, north]. */
export function cellSizeMeters(field: FlowField): [number, number] {
  const [west, south, east, north] = field.bounds
  const latitudeRadians = ((south + north) / 2) * Math.PI / 180
  return [
    (east - west) * 111_320 * Math.cos(latitudeRadians) / field.width,
    (north - south) * 110_540 / field.height,
  ]
}

/**
 * Unit vector toward the sun in (east, north, up). The azimuth is degrees
 * clockwise from north, matching the hillshade illumination convention.
 */
export function sunDirection(
  azimuthDegrees: number,
  elevationDegrees: number,
): [number, number, number] {
  const azimuth = azimuthDegrees * Math.PI / 180
  const elevation = elevationDegrees * Math.PI / 180
  return [
    Math.sin(azimuth) * Math.cos(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
  ]
}

/** Crossfade weight of the incoming field, 1 when the transition is done. */
export function crossfadeWeight(elapsedMs: number, reducedMotion: boolean) {
  if (reducedMotion || elapsedMs >= CROSSFADE_MS) return 1
  return Math.max(0, elapsedMs / CROSSFADE_MS)
}

const VERTEX_SHADER = `
attribute vec3 a_position;
attribute vec2 a_uv;
varying vec2 v_uv;
uniform mat4 u_matrix;
uniform float u_clearance;
void main() {
  v_uv = a_uv;
  gl_Position = u_matrix * vec4(a_position.xy, a_position.z + u_clearance, 1.0);
}
`

const FRAGMENT_SHADER = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_field_current;
uniform sampler2D u_field_previous;
uniform float u_fade;
uniform vec2 u_grid_size;
uniform vec2 u_cell_meters;
uniform float u_time;
uniform vec3 u_sun;
uniform float u_specular;
uniform float u_sheen;
uniform float u_sparkle;
uniform float u_amplitude;
uniform vec2 u_wave_length;
uniform float u_advect;
uniform float u_feather;
uniform float u_full_depth;
uniform float u_colorize;
uniform float u_shadow;
uniform float u_water_alpha;
uniform float u_format;
uniform float u_quantity;

vec4 sampleField(sampler2D tex, vec2 uv) {
  vec2 g = uv * u_grid_size - 0.5;
  vec2 base = floor(g);
  vec2 f = g - base;
  vec4 sum = vec4(0.0);
  float weightSum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 corner = vec2(mod(float(i), 2.0), floor(float(i) / 2.0));
    vec2 texel = base + corner;
    float w = mix(1.0 - f.x, f.x, corner.x) * mix(1.0 - f.y, f.y, corner.y);
    if (w == 0.0) continue;
    if (texel.x < 0.0 || texel.y < 0.0) continue;
    if (texel.x > u_grid_size.x - 1.0 || texel.y > u_grid_size.y - 1.0) continue;
    sum += texture2D(tex, (texel + 0.5) / u_grid_size) * w;
    weightSum += w;
  }
  if (weightSum == 0.0) return vec4(0.0);
  return sum / weightSum;
}

// Sin-free hash (David Hoskins): trigonometric hashes are measurably slower
// in fragment shaders on some mobile GPUs.
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 t = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

float waveHeight(vec2 q) {
  return vnoise(q / u_wave_length.x) + vnoise(q / u_wave_length.y) * 0.45;
}

// Matches the depth legend (ColorBrewer Blues), with the shallow end nudged
// from #f7fbff toward a touch of blue so ripple shading stays visible.
vec3 depthRamp(float t) {
  vec3 c0 = vec3(0.886, 0.933, 0.973);
  vec3 c1 = vec3(0.620, 0.792, 0.882);
  vec3 c2 = vec3(0.259, 0.573, 0.776);
  vec3 c3 = vec3(0.031, 0.318, 0.612);
  if (t < 0.34) return mix(c0, c1, t / 0.34);
  if (t < 0.67) return mix(c1, c2, (t - 0.34) / 0.33);
  return mix(c2, c3, (t - 0.67) / 0.33);
}

// Matches the stage legend (viridis approximation).
vec3 stageRamp(float t) {
  vec3 c0 = vec3(0.267, 0.005, 0.329);
  vec3 c1 = vec3(0.192, 0.408, 0.557);
  vec3 c2 = vec3(0.208, 0.718, 0.475);
  vec3 c3 = vec3(0.992, 0.906, 0.145);
  if (t < 0.34) return mix(c0, c1, t / 0.34);
  if (t < 0.67) return mix(c1, c2, (t - 0.34) / 0.33);
  return mix(c2, c3, (t - 0.67) / 0.33);
}

// Matches the speed legend (ColorBrewer YlOrRd).
vec3 speedRamp(float t) {
  vec3 c0 = vec3(1.0, 1.0, 0.8);
  vec3 c1 = vec3(0.996, 0.698, 0.298);
  vec3 c2 = vec3(0.941, 0.231, 0.125);
  vec3 c3 = vec3(0.502, 0.0, 0.149);
  if (t < 0.34) return mix(c0, c1, t / 0.34);
  if (t < 0.67) return mix(c1, c2, (t - 0.34) / 0.33);
  return mix(c2, c3, (t - 0.67) / 0.33);
}

void main() {
  vec4 field = sampleField(u_field_current, v_uv);
  if (u_fade < 1.0) {
    field = mix(sampleField(u_field_previous, v_uv), field, u_fade);
  }
  // v3 fields carry (u, v, depth, stage) with dry cells marked by the exact
  // sentinel depth -1; legacy fields carry (u, v, depth, wetFlag).
  float depth = field.b;
  float wet;
  float stage;
  if (u_format > 0.5) {
    wet = step(0.0, depth);
    depth = max(depth, 0.0);
    stage = field.a;
  } else {
    wet = field.a;
    stage = 0.0;
  }
  float alpha = wet * smoothstep(0.0, u_feather, depth);
  if (alpha < 0.004) discard;

  vec2 velocity = field.rg;
  float speed = length(velocity);

  // Ripple coordinates in grid cells, y increasing northward, advected by
  // the local flow so the wave pattern travels with the water.
  vec2 cell = vec2(v_uv.x, 1.0 - v_uv.y) * u_grid_size;
  vec2 q = cell - velocity * (u_time * u_advect) / max(u_cell_meters, vec2(0.001));

  float eps = 0.18;
  float dx = waveHeight(q + vec2(eps, 0.0)) - waveHeight(q - vec2(eps, 0.0));
  float dy = waveHeight(q + vec2(0.0, eps)) - waveHeight(q - vec2(0.0, eps));

  float depthFactor = clamp(depth / u_full_depth, 0.0, 1.0);
  float speedFactor = clamp(speed / 1.5, 0.15, 1.0);
  float amp = u_amplitude * depthFactor * speedFactor * 0.6;
  vec3 normal = normalize(vec3(-dx * amp, -dy * amp, 1.0));

  float diffuse = max(dot(normal, u_sun), 0.0);
  float sheen = max(diffuse - u_sun.z, 0.0) / max(1.0 - u_sun.z, 0.001);
  float specular = pow(max(dot(reflect(-u_sun, normal), vec3(0.0, 0.0, 1.0)), 0.0), 64.0);
  float light = u_sheen * sheen + u_specular * specular;

  if (u_sparkle > 0.0 && speed > 0.5) {
    float sparkle = vnoise(q * 2.7 + vec2(u_time * 3.0, -u_time * 2.2));
    light += u_sparkle * smoothstep(0.72, 0.95, sparkle) * clamp(speed / 2.0, 0.0, 1.0);
  }
  light = max(light, 0.0);

  if (u_colorize > 0.5) {
    // Full water-surface rendering: legend-aligned ramps for the selected
    // quantity, ripple relief from two-tone shading (shadows carry the
    // shallow end where additive highlights would vanish on pale blue).
    vec3 base;
    if (u_quantity < 0.5) {
      base = depthRamp(clamp((depth - 0.01) / (3.0 - 0.01), 0.0, 1.0));
    } else if (u_quantity < 1.5) {
      base = stageRamp(clamp(stage / 30.0, 0.0, 1.0));
    } else {
      base = speedRamp(clamp(speed / 3.0, 0.0, 1.0));
    }
    float shade = clamp((u_sun.z - diffuse) / max(u_sun.z, 0.001), 0.0, 1.0);
    vec3 color = base * (1.0 - u_shadow * shade) + vec3(light);
    float a = alpha * u_water_alpha;
    gl_FragColor = vec4(color * a, a);
    return;
  }

  gl_FragColor = vec4(vec3(light * alpha), 1.0);
}
`

interface RippleResources {
  program: WebGLProgram
  mesh: WebGLBuffer
  indices: WebGLBuffer
  indexCount: number
  current: WebGLTexture | null
  previous: WebGLTexture | null
  attributes: { position: number; uv: number }
  uniforms: Record<string, WebGLUniformLocation | null>
}

const UNIFORM_NAMES = [
  'u_matrix', 'u_clearance',
  'u_field_current', 'u_field_previous', 'u_fade', 'u_grid_size',
  'u_cell_meters', 'u_time', 'u_sun', 'u_specular', 'u_sheen', 'u_sparkle',
  'u_amplitude', 'u_wave_length', 'u_advect', 'u_feather', 'u_full_depth',
  'u_colorize', 'u_shadow', 'u_water_alpha', 'u_format', 'u_quantity',
]

const QUANTITY_CODES: Record<ResultQuantity, number> = {
  depth: 0,
  stage: 1,
  speed: 2,
}

// Keep the water geometry close to the 512-cell flow field while bounding
// memory when three result maps are visible. The former 48-cell mesh crossed
// through finer terrain triangles and produced camera-dependent strip gaps.
const MAX_MESH_CELLS = 256
let nextLayerId = 0

/** Decode one IEEE-754 binary16 value from the v3 flow payload. */
export function halfFloatToNumber(bits: number) {
  const sign = bits & 0x8000 ? -1 : 1
  const exponent = (bits >>> 10) & 0x1f
  const fraction = bits & 0x03ff
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024)
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024)
}

interface SurfaceSample { depth: number; stage: number }

function sampleSurface(field: FlowField, u: number, v: number): SurfaceSample | null {
  const gridX = u * field.width - 0.5
  const gridY = v * field.height - 0.5
  const column = Math.floor(gridX)
  const row = Math.floor(gridY)
  const fractionX = gridX - column
  const fractionY = gridY - row
  let depth = 0
  let stage = 0
  let weightSum = 0
  for (let corner = 0; corner < 4; corner += 1) {
    const x = column + (corner & 1)
    const y = row + (corner >> 1)
    if (x < 0 || x >= field.width || y < 0 || y >= field.height) continue
    const weight = (corner & 1 ? fractionX : 1 - fractionX)
      * (corner >> 1 ? fractionY : 1 - fractionY)
    if (weight <= 0) continue
    const cell = y * field.width + x
    let cellDepth: number
    let cellStage: number
    if (field.texels) {
      cellDepth = halfFloatToNumber(field.texels[cell * 4 + 2])
      cellStage = halfFloatToNumber(field.texels[cell * 4 + 3])
      if (cellDepth < 0 || !Number.isFinite(cellStage)) continue
    } else {
      cellDepth = field.depths?.[cell] ?? Number.NaN
      if (!Number.isFinite(cellDepth)) continue
      cellStage = Number.NaN
    }
    depth += cellDepth * weight
    if (Number.isFinite(cellStage)) stage += cellStage * weight
    weightSum += weight
  }
  if (weightSum === 0) return null
  return { depth: depth / weightSum, stage: stage / weightSum }
}

function fillMissingAltitudes(
  altitudes: Float64Array,
  columns: number,
  rows: number,
) {
  const queue = new Int32Array(altitudes.length)
  let head = 0
  let tail = 0
  for (let vertex = 0; vertex < altitudes.length; vertex += 1) {
    if (Number.isFinite(altitudes[vertex])) queue[tail++] = vertex
  }
  if (tail === 0) {
    altitudes.fill(0)
    return
  }
  while (head < tail) {
    const vertex = queue[head++]
    const row = Math.floor(vertex / columns)
    const column = vertex - row * columns
    if (column > 0) tail = fillNeighbour(altitudes, queue, tail, vertex, vertex - 1)
    if (column + 1 < columns) tail = fillNeighbour(altitudes, queue, tail, vertex, vertex + 1)
    if (row > 0) tail = fillNeighbour(altitudes, queue, tail, vertex, vertex - columns)
    if (row + 1 < rows) tail = fillNeighbour(altitudes, queue, tail, vertex, vertex + columns)
  }
}

function fillNeighbour(
  altitudes: Float64Array,
  queue: Int32Array,
  tail: number,
  source: number,
  neighbour: number,
) {
  if (Number.isFinite(altitudes[neighbour])) return tail
  altitudes[neighbour] = altitudes[source]
  queue[tail] = neighbour
  return tail + 1
}

export interface WaterSurfaceMesh {
  /** Interleaved mercator x/y/z and field u/v. */
  vertices: Float32Array
  indices: Uint32Array
}

/**
 * Build a terrain-aware geographic mesh. Unlike the former four-corner
 * screen quad, every vertex remains in map coordinates and is transformed by
 * MapLibre's camera matrix, so perspective and camera altitude cannot move
 * the texture relative to the map.
 */
export function buildWaterSurfaceMesh(
  map: Map,
  field: FlowField,
  terrainExaggeration = 0,
): WaterSurfaceMesh {
  const columns = Math.min(field.width, MAX_MESH_CELLS)
  const rows = Math.min(field.height, MAX_MESH_CELLS)
  const vertexColumns = columns + 1
  const vertexRows = rows + 1
  const vertexCount = vertexColumns * vertexRows
  const vertices = new Float32Array(vertexCount * 5)
  const altitudes = new Float64Array(vertexCount)
  altitudes.fill(Number.NaN)
  for (let row = 0; row < vertexRows; row += 1) {
    const v = row / rows
    for (let column = 0; column < vertexColumns; column += 1) {
      const u = column / columns
      const [longitude, latitude] = gridUvToLngLat(field, u, v)
      const sample = sampleSurface(field, u, v)
      const vertex = row * vertexColumns + column
      if (sample && field.texels) {
        // Stage and DEM use the same vertical datum. Terrain exaggeration is
        // applied only to the ground component; water depth remains physical.
        const ground = sample.stage - sample.depth
        altitudes[vertex] = terrainExaggeration > 0
          ? ground * terrainExaggeration + sample.depth
          : sample.stage
      } else if (!field.texels) {
        const terrain = map.queryTerrainElevation([longitude, latitude])
        altitudes[vertex] = (terrain ?? 0) + (sample?.depth ?? 0)
      }
    }
  }

  // Dry v3 texels intentionally contain no stage. Extend the nearest wet
  // surface altitude through masked geometry so triangles at a shoreline do
  // not dive toward sea level. These fragments are still discarded by the
  // wet mask; the fill only stabilises interpolation at their shared edges.
  fillMissingAltitudes(altitudes, vertexColumns, vertexRows)

  let offset = 0
  for (let row = 0; row < vertexRows; row += 1) {
    const v = row / rows
    for (let column = 0; column < vertexColumns; column += 1) {
      const u = column / columns
      const [longitude, latitude] = gridUvToLngLat(field, u, v)
      const vertex = row * vertexColumns + column
      const altitude = altitudes[vertex]
      const coordinate = MercatorCoordinate.fromLngLat([longitude, latitude], altitude)
      vertices[offset++] = coordinate.x
      vertices[offset++] = coordinate.y
      vertices[offset++] = coordinate.z
      vertices[offset++] = u
      vertices[offset++] = v
    }
  }
  // 256×256 cells have 66,049 vertices, just beyond Uint16's addressable
  // range. WebGL2 guarantees 32-bit element indices.
  const indices = new Uint32Array(columns * rows * 6)
  offset = 0
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const nw = row * (columns + 1) + column
      const sw = (row + 1) * (columns + 1) + column
      const ne = nw + 1
      const se = sw + 1
      // Counter-clockwise when viewed from above. Terrain rendering may
      // leave face culling enabled in the shared WebGL context.
      indices[offset++] = nw
      indices[offset++] = ne
      indices[offset++] = sw
      indices[offset++] = ne
      indices[offset++] = se
      indices[offset++] = sw
    }
  }
  return { vertices, indices }
}

/**
 * Procedural water rendered as a MapLibre 3D custom layer. Rendering in the
 * map's own WebGL context supplies the authoritative camera matrix and depth
 * buffer, keeping the surface fixed to terrain at every pitch and zoom.
 */
export class WaterRippleLayer implements CustomLayerInterface {
  readonly id = `water-ripple-${nextLayerId++}`
  readonly type = 'custom' as const
  readonly renderingMode = '3d' as const
  private gl: WebGL2RenderingContext | null = null
  private resources: RippleResources | null = null
  private field: FlowField | null = null
  private fadeStartedAt = 0
  private readonly startedAt = performance.now()
  private colorize = false
  private quantity: ResultQuantity = 'depth'
  private terrainExaggeration = 0
  private repaintTimer: ReturnType<typeof setTimeout> | null = null
  private added = false
  private destroyed = false
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

  constructor(private readonly map: Map) {
    this.reducedMotion.addEventListener('change', this.motionPreferenceChanged)
    if (map.isStyleLoaded()) this.addToMap()
    else map.once('load', this.addToMap)
  }

  private readonly addToMap = () => {
    if (this.destroyed || this.added || this.map.getLayer(this.id)) return
    this.map.addLayer(this)
    this.added = true
  }

  onAdd(_map: Map, context: WebGLRenderingContext | WebGL2RenderingContext) {
    if (!(context instanceof WebGL2RenderingContext)) {
      throw new Error('水波效果需要 WebGL2')
    }
    this.gl = context
    this.initGL()
    if (this.field) this.upload(this.field, false)
  }

  onRemove() {
    this.releaseGL()
    this.gl = null
    this.added = false
  }

  setField(field: FlowField | null) {
    const previous = this.field
    this.field = field
    if (!field) {
      this.clearTextures()
      delete this.map.getContainer().dataset.waterRipple
      this.cancelRepaint()
      this.map.triggerRepaint()
      return
    }
    const sameGrid = previous != null
      && previous.width === field.width && previous.height === field.height
    this.fadeStartedAt = performance.now()
    if (this.resources) this.upload(field, sameGrid)
    this.map.getContainer().dataset.waterRipple = 'active'
    this.map.triggerRepaint()
  }

  setColorize(colorize: boolean) {
    if (this.colorize === colorize) return
    this.colorize = colorize
    this.updateDataset()
    this.map.triggerRepaint()
  }

  setQuantity(quantity: ResultQuantity) {
    if (this.quantity === quantity) return
    this.quantity = quantity
    this.updateDataset()
    this.map.triggerRepaint()
  }

  /** Match MapLibre's visual terrain exaggeration when positioning water. */
  setTerrainExaggeration(exaggeration: number) {
    const next = Math.max(0, exaggeration)
    if (this.terrainExaggeration === next) return
    this.terrainExaggeration = next
    if (this.field && this.resources) this.uploadMesh(this.field)
    this.map.triggerRepaint()
  }

  private updateDataset() {
    const container = this.map.getContainer()
    if (this.colorize) container.dataset.waterColorize = '1'
    else delete container.dataset.waterColorize
    if (this.colorize) container.dataset.waterQuantity = this.quantity
    else delete container.dataset.waterQuantity
  }

  destroy() {
    this.destroyed = true
    this.cancelRepaint()
    this.map.off('load', this.addToMap)
    if (this.map.getLayer(this.id)) this.map.removeLayer(this.id)
    else this.releaseGL()
    delete this.map.getContainer().dataset.waterRipple
    delete this.map.getContainer().dataset.waterColorize
    delete this.map.getContainer().dataset.waterQuantity
    this.reducedMotion.removeEventListener('change', this.motionPreferenceChanged)
  }

  private initGL() {
    const gl = this.gl
    if (!gl) return
    this.releaseGL()
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    const program = mustCreate(gl.createProgram(), 'shader 程序')
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program)
      gl.deleteProgram(program)
      throw new Error(`水波 shader 链接失败: ${log ?? '未知错误'}`)
    }
    const uniforms: Record<string, WebGLUniformLocation | null> = {}
    for (const name of UNIFORM_NAMES) uniforms[name] = gl.getUniformLocation(program, name)
    this.resources = {
      program,
      mesh: mustCreate(gl.createBuffer(), '网格缓冲'),
      indices: mustCreate(gl.createBuffer(), '索引缓冲'),
      indexCount: 0,
      current: null,
      previous: null,
      attributes: {
        position: gl.getAttribLocation(program, 'a_position'),
        uv: gl.getAttribLocation(program, 'a_uv'),
      },
      uniforms,
    }
  }

  private releaseGL() {
    const gl = this.gl
    const resources = this.resources
    if (!gl || !resources) return
    if (resources.current) gl.deleteTexture(resources.current)
    if (resources.previous) gl.deleteTexture(resources.previous)
    gl.deleteBuffer(resources.mesh)
    gl.deleteBuffer(resources.indices)
    gl.deleteProgram(resources.program)
    this.resources = null
  }

  private upload(field: FlowField, keepPrevious: boolean) {
    const gl = this.gl
    const resources = this.resources
    if (!gl || !resources) return
    const texture = mustCreate(gl.createTexture(), '场纹理')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (field.texels) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, field.width, field.height, 0,
        gl.RGBA, gl.HALF_FLOAT, field.texels)
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, field.width, field.height, 0,
        gl.RGBA, gl.FLOAT, packFieldPixels(field))
    }
    if (resources.current && keepPrevious) {
      if (resources.previous) gl.deleteTexture(resources.previous)
      resources.previous = resources.current
    } else {
      if (resources.previous) gl.deleteTexture(resources.previous)
      if (resources.current) gl.deleteTexture(resources.current)
      resources.previous = null
    }
    resources.current = texture
    this.uploadMesh(field)
  }

  private uploadMesh(field: FlowField) {
    const gl = this.gl
    const resources = this.resources
    if (!gl || !resources) return
    const mesh = buildWaterSurfaceMesh(this.map, field, this.terrainExaggeration)
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.mesh)
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, resources.indices)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW)
    resources.indexCount = mesh.indices.length
  }

  private clearTextures() {
    const gl = this.gl
    const resources = this.resources
    if (!gl || !resources) return
    if (resources.current) gl.deleteTexture(resources.current)
    if (resources.previous) gl.deleteTexture(resources.previous)
    resources.current = null
    resources.previous = null
  }

  render(
    glContext: WebGLRenderingContext | WebGL2RenderingContext,
    options: CustomRenderMethodInput,
  ) {
    const gl = glContext as WebGL2RenderingContext
    const resources = this.resources
    const field = this.field
    if (!resources || !resources.current || !field) return
    const { program, uniforms } = resources
    const now = performance.now()
    const fade = resources.previous
      ? crossfadeWeight(now - this.fadeStartedAt, this.reducedMotion.matches)
      : 1
    if (fade >= 1 && resources.previous) {
      gl.deleteTexture(resources.previous)
      resources.previous = null
    }
    const time = this.reducedMotion.matches ? 0 : (now - this.startedAt) / 1000
    const params = waterRippleParams
    const sun = sunDirection(params.sunAzimuth, params.sunElevation)
    const cellMeters = cellSizeMeters(field)

    gl.useProgram(program)
    // Custom-layer vertices use normalized Mercator coordinates. The generic
    // modelViewProjectionMatrix operates on MapLibre world coordinates;
    // defaultProjectionData.mainMatrix is the matrix explicitly scaled for
    // custom-layer Mercator coordinates in the 0..1 range.
    gl.uniformMatrix4fv(uniforms.u_matrix, false, options.defaultProjectionData.mainMatrix)
    const center = gridUvToLngLat(field, 0.5, 0.5)
    const clearance = MercatorCoordinate.fromLngLat(
      center,
      Math.max(0, params.terrainClearanceM),
    ).z
    gl.uniform1f(uniforms.u_clearance, clearance)
    gl.uniform1f(uniforms.u_fade, fade)
    gl.uniform2f(uniforms.u_grid_size, field.width, field.height)
    gl.uniform2f(uniforms.u_cell_meters, cellMeters[0], cellMeters[1])
    gl.uniform1f(uniforms.u_time, time)
    gl.uniform3f(uniforms.u_sun, sun[0], sun[1], sun[2])
    gl.uniform1f(uniforms.u_specular, params.specularStrength)
    gl.uniform1f(uniforms.u_sheen, params.sheenStrength)
    gl.uniform1f(uniforms.u_sparkle, params.sparkleStrength)
    gl.uniform1f(uniforms.u_amplitude, params.amplitude)
    gl.uniform2f(uniforms.u_wave_length, params.waveLengthLarge, params.waveLengthSmall)
    gl.uniform1f(uniforms.u_advect, params.advectScale)
    gl.uniform1f(uniforms.u_feather, Math.max(params.featherDepthM, 0.001))
    gl.uniform1f(uniforms.u_full_depth, Math.max(params.fullAmplitudeDepthM, 0.01))
    gl.uniform1f(uniforms.u_colorize, this.colorize ? 1 : 0)
    gl.uniform1f(uniforms.u_shadow, params.shadowStrength)
    gl.uniform1f(uniforms.u_water_alpha, params.waterAlpha)
    gl.uniform1f(uniforms.u_format, field.texels ? 1 : 0)
    const quantity = this.quantity === 'stage' && !field.texels ? 'depth' : this.quantity
    gl.uniform1f(uniforms.u_quantity, QUANTITY_CODES[quantity])

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, resources.current)
    gl.uniform1i(uniforms.u_field_current, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, resources.previous ?? resources.current)
    gl.uniform1i(uniforms.u_field_previous, 1)
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.mesh)
    gl.enableVertexAttribArray(resources.attributes.position)
    gl.vertexAttribPointer(resources.attributes.position, 3, gl.FLOAT, false, 20, 0)
    gl.enableVertexAttribArray(resources.attributes.uv)
    gl.vertexAttribPointer(resources.attributes.uv, 2, gl.FLOAT, false, 20, 12)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, resources.indices)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.CULL_FACE)
    gl.depthMask(false)
    // A small depth bias handles residual raster-vs-mesh interpolation error
    // without disabling terrain occlusion for genuinely hidden water.
    gl.enable(gl.POLYGON_OFFSET_FILL)
    const depthBias = Math.max(0, params.terrainDepthBias)
    gl.polygonOffset(-depthBias, -depthBias)
    gl.drawElements(gl.TRIANGLES, resources.indexCount, gl.UNSIGNED_INT, 0)
    gl.disable(gl.POLYGON_OFFSET_FILL)
    this.scheduleRepaint()
  }

  private scheduleRepaint() {
    if (this.reducedMotion.matches || !this.field || this.repaintTimer != null) return
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = null
      if (this.field && !this.destroyed) this.map.triggerRepaint()
    }, 33)
  }

  private cancelRepaint() {
    if (this.repaintTimer != null) clearTimeout(this.repaintTimer)
    this.repaintTimer = null
  }

  private readonly motionPreferenceChanged = () => {
    if (this.reducedMotion.matches) this.cancelRepaint()
    this.map.triggerRepaint()
  }
}
function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = mustCreate(gl.createShader(type), 'shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`水波 shader 编译失败: ${log ?? '未知错误'}`)
  }
  return shader
}

function mustCreate<T>(value: T | null, label: string): T {
  if (value == null) throw new Error(`水波效果初始化失败: 无法创建${label}`)
  return value
}
