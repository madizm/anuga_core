import { MercatorCoordinate, type CustomLayerInterface, type Map } from 'maplibre-gl'
import type { FlowField } from '../api/types'
import { waterRippleParams } from './waterRippleParams'

export const WATER_RIPPLE_LAYER_ID = 'water-ripple'
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
attribute vec2 a_pos;
attribute vec2 a_uv;
uniform mat4 u_matrix;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
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

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
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

void main() {
  vec4 field = sampleField(u_field_current, v_uv);
  if (u_fade < 1.0) {
    field = mix(sampleField(u_field_previous, v_uv), field, u_fade);
  }
  float alpha = field.a * smoothstep(0.0, u_feather, field.b);
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

  float depthFactor = clamp(field.b / u_full_depth, 0.0, 1.0);
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

  gl_FragColor = vec4(vec3(max(light, 0.0) * alpha), 0.0);
}
`

interface RippleResources {
  gl: WebGL2RenderingContext
  program: WebGLProgram
  quad: WebGLBuffer
  current: WebGLTexture | null
  previous: WebGLTexture | null
  attributes: { pos: number; uv: number }
  uniforms: Record<string, WebGLUniformLocation | null>
}

const UNIFORM_NAMES = [
  'u_matrix', 'u_field_current', 'u_field_previous', 'u_fade', 'u_grid_size',
  'u_cell_meters', 'u_time', 'u_sun', 'u_specular', 'u_sheen', 'u_sparkle',
  'u_amplitude', 'u_wave_length', 'u_advect', 'u_feather', 'u_full_depth',
]

/**
 * Additive water-surface shimmer rendered straight into the map's own WebGL2
 * context as a custom layer: procedural ripple normals advected by the frame
 * velocity field, sun specular, wet-edge feathering from the depth plane.
 * Renders as a 2D overlay (like the particle layer), so under 3D terrain it
 * stays a flat projection.
 */
export class WaterRippleLayer {
  private resources: RippleResources | null = null
  private field: FlowField | null = null
  private fadeStartedAt = 0
  private readonly startedAt = performance.now()
  private animationFrame: number | null = null
  private contextLost = false
  private rendered = false
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

  constructor(
    private readonly map: Map,
    private readonly onError?: (message: string) => void,
  ) {
    map.on('webglcontextlost', this.handleContextLost)
    map.on('webglcontextrestored', this.handleContextRestored)
    if (map.isStyleLoaded()) this.install()
    else map.once('load', this.install)
  }

  /** Re-attempts installation after a previous failure. */
  retry() {
    this.install()
  }

  private readonly install = () => {
    try {
      if (!this.map.getLayer(WATER_RIPPLE_LAYER_ID)) this.map.addLayer(this.spec)
    } catch (error) {
      // onAdd throws synchronously out of addLayer, but the layer object is
      // already registered in the style; remove the zombie before reporting.
      if (this.map.getLayer(WATER_RIPPLE_LAYER_ID)) {
        this.map.removeLayer(WATER_RIPPLE_LAYER_ID)
      }
      this.onError?.((error as Error).message || '水波效果初始化失败')
    }
  }

  setField(field: FlowField | null) {
    const previous = this.field
    this.field = field
    if (!field) {
      this.stop()
      this.clearTextures()
      this.rendered = false
      delete this.map.getContainer().dataset.waterRipple
      this.map.triggerRepaint()
      return
    }
    const sameGrid = previous != null
      && previous.width === field.width && previous.height === field.height
    this.fadeStartedAt = performance.now()
    // Without GL resources (style not loaded yet, or context lost) onAdd
    // picks the field up and uploads it once they exist.
    if (this.resources) this.upload(field, sameGrid)
    if (this.reducedMotion.matches) {
      this.map.triggerRepaint()
    } else if (this.animationFrame == null) {
      this.animationFrame = requestAnimationFrame(this.animate)
    }
  }

  destroy() {
    this.stop()
    delete this.map.getContainer().dataset.waterRipple
    this.map.off('load', this.install)
    this.map.off('webglcontextlost', this.handleContextLost)
    this.map.off('webglcontextrestored', this.handleContextRestored)
    if (this.map.getLayer(WATER_RIPPLE_LAYER_ID)) {
      this.map.removeLayer(WATER_RIPPLE_LAYER_ID)
    }
  }

  private readonly spec: CustomLayerInterface = {
    id: WATER_RIPPLE_LAYER_ID,
    type: 'custom',
    renderingMode: '2d',
    onAdd: (_map, gl) => {
      this.initGL(gl as WebGL2RenderingContext)
    },
    render: (_gl, options) => {
      // mainMatrix is pre-scaled to accept mercator world coordinates [0..1].
      // MapLibre hands us a 64-bit matrix; WebGL uniforms need 32-bit.
      this.render(new Float32Array(options.defaultProjectionData.mainMatrix))
    },
    onRemove: () => this.releaseGL(),
  }

  private initGL(gl: WebGL2RenderingContext) {
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) {
      throw new Error('水波效果需要 WebGL2')
    }
    this.releaseGL()
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    const program = gl.createProgram()
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
    for (const name of UNIFORM_NAMES) {
      uniforms[name] = gl.getUniformLocation(program, name)
    }
    this.resources = {
      gl,
      program,
      quad: mustCreate(gl.createBuffer(), '顶点缓冲'),
      current: null,
      previous: null,
      attributes: {
        pos: gl.getAttribLocation(program, 'a_pos'),
        uv: gl.getAttribLocation(program, 'a_uv'),
      },
      uniforms,
    }
    if (this.field) this.upload(this.field, false)
  }

  private releaseGL() {
    const resources = this.resources
    if (!resources) return
    const { gl } = resources
    if (resources.current) gl.deleteTexture(resources.current)
    if (resources.previous) gl.deleteTexture(resources.previous)
    gl.deleteBuffer(resources.quad)
    gl.deleteProgram(resources.program)
    this.resources = null
  }

  private upload(field: FlowField, keepPrevious: boolean) {
    const resources = this.resources
    if (!resources) return
    const { gl } = resources
    const texture = mustCreate(gl.createTexture(), '场纹理')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA32F, field.width, field.height, 0,
      gl.RGBA, gl.FLOAT, packFieldPixels(field),
    )
    if (resources.current && keepPrevious) {
      if (resources.previous) gl.deleteTexture(resources.previous)
      resources.previous = resources.current
    } else {
      if (resources.previous) gl.deleteTexture(resources.previous)
      if (resources.current) gl.deleteTexture(resources.current)
      resources.previous = null
    }
    resources.current = texture

    const [west, south, east, north] = field.bounds
    const nw = MercatorCoordinate.fromLngLat({ lng: west, lat: north }, 0)
    const ne = MercatorCoordinate.fromLngLat({ lng: east, lat: north }, 0)
    const sw = MercatorCoordinate.fromLngLat({ lng: west, lat: south }, 0)
    const se = MercatorCoordinate.fromLngLat({ lng: east, lat: south }, 0)
    // a_pos in mercator world units, a_uv in grid space (row 0 = north).
    const vertices = new Float32Array([
      nw.x, nw.y, 0, 0,
      sw.x, sw.y, 0, 1,
      ne.x, ne.y, 1, 0,
      ne.x, ne.y, 1, 0,
      sw.x, sw.y, 0, 1,
      se.x, se.y, 1, 1,
    ])
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.quad)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
  }

  private clearTextures() {
    const resources = this.resources
    if (!resources) return
    if (resources.current) resources.gl.deleteTexture(resources.current)
    if (resources.previous) resources.gl.deleteTexture(resources.previous)
    resources.current = null
    resources.previous = null
  }

  private readonly animate = () => {
    this.animationFrame = null
    if (!this.field || this.contextLost) return
    this.map.triggerRepaint()
    this.animationFrame = requestAnimationFrame(this.animate)
  }

  private render(matrix: Float32Array) {
    const resources = this.resources
    const field = this.field
    if (!resources || !resources.current || !field || this.contextLost) return
    const { gl, program, uniforms } = resources
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
    gl.uniformMatrix4fv(uniforms.u_matrix, false, matrix)
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

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, resources.current)
    gl.uniform1i(uniforms.u_field_current, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, resources.previous ?? resources.current)
    gl.uniform1i(uniforms.u_field_previous, 1)

    gl.bindBuffer(gl.ARRAY_BUFFER, resources.quad)
    gl.enableVertexAttribArray(resources.attributes.pos)
    gl.vertexAttribPointer(resources.attributes.pos, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(resources.attributes.uv)
    gl.vertexAttribPointer(resources.attributes.uv, 2, gl.FLOAT, false, 16, 8)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    if (!this.rendered) {
      this.rendered = true
      this.map.getContainer().dataset.waterRipple = 'active'
    }
    // MapLibre expects premultiplied-alpha blending; restore its default.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.disableVertexAttribArray(resources.attributes.pos)
    gl.disableVertexAttribArray(resources.attributes.uv)
  }

  private readonly handleContextLost = () => {
    this.contextLost = true
    this.stop()
    // The GL objects died with the context; drop the references without
    // making delete calls into a dead context.
    this.resources = null
  }

  private readonly handleContextRestored = () => {
    this.contextLost = false
    // MapLibre rebuilt the style without custom layers; put ours back. The
    // CPU-side field survived, so the texture re-uploads in onAdd.
    if (this.map.isStyleLoaded()) this.install()
    else this.map.once('load', this.install)
    if (this.field && !this.reducedMotion.matches && this.animationFrame == null) {
      this.animationFrame = requestAnimationFrame(this.animate)
    }
  }

  private stop() {
    if (this.animationFrame != null) cancelAnimationFrame(this.animationFrame)
    this.animationFrame = null
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
