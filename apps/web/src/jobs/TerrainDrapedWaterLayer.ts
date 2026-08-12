import type { CanvasSource, Map } from 'maplibre-gl'
import type { FlowField, ResultQuantity } from '../api/types'
import { gridUvToLngLat } from './flowGrid'
import { waterRippleParams } from './waterRippleParams'

const CROSSFADE_MS = 220
const MAX_CANVAS_DIMENSION = 512
const PIXELS_PER_CELL = 4
const REPAINT_MS = 33

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

/** CanvasSource expects clockwise corners starting at the northwest corner. */
export function waterCanvasCoordinates(field: FlowField) {
  return [
    gridUvToLngLat(field, 0, 0),
    gridUvToLngLat(field, 1, 0),
    gridUvToLngLat(field, 1, 1),
    gridUvToLngLat(field, 0, 1),
  ] as [[number, number], [number, number], [number, number], [number, number]]
}

/** Keep enough pixels for ripple relief without uploading a full-screen canvas. */
export function waterCanvasSize(field: Pick<FlowField, 'width' | 'height'>) {
  const scale = Math.min(
    PIXELS_PER_CELL,
    MAX_CANVAS_DIMENSION / Math.max(field.width, field.height),
  )
  return [
    Math.max(1, Math.round(field.width * scale)),
    Math.max(1, Math.round(field.height * scale)),
  ] as const
}

const VERTEX_SHADER = `
attribute vec2 a_position;
attribute vec2 a_uv;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_position, 0.0, 1.0);
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
  // v3/v4 fields carry (u, v, depth, stage) with dry cells marked by the
  // exact sentinel depth -1; legacy fields carry (u, v, depth, wetFlag).
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
    gl_FragColor = vec4(color, alpha * u_water_alpha);
    return;
  }

  float highlightAlpha = clamp(light * alpha, 0.0, 1.0);
  gl_FragColor = vec4(vec3(1.0), highlightAlpha);
}
`

interface RippleResources {
  program: WebGLProgram
  quad: WebGLBuffer
  current: WebGLTexture | null
  previous: WebGLTexture | null
  attributes: { position: number; uv: number }
  uniforms: Record<string, WebGLUniformLocation | null>
}

const UNIFORM_NAMES = [
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

let nextLayerId = 0

/**
 * Procedural water rendered into a private canvas and exposed to MapLibre as
 * a raster layer. MapLibre drapes that layer through its own terrain render
 * path, so water and terrain share one tessellation instead of competing in
 * the depth buffer as independent 3D meshes.
 */
export class TerrainDrapedWaterLayer {
  readonly id = `water-ripple-${nextLayerId++}`
  readonly sourceId = `${this.id}-canvas`
  private readonly canvas = document.createElement('canvas')
  private readonly gl: WebGL2RenderingContext
  private resources: RippleResources | null = null
  private field: FlowField | null = null
  private fadeStartedAt = 0
  private readonly startedAt = performance.now()
  private colorize = false
  private animated = true
  private quantity: ResultQuantity = 'depth'
  private repaintTimer: ReturnType<typeof setTimeout> | null = null
  private added = false
  private destroyed = false
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

  constructor(private readonly map: Map) {
    this.canvas.width = 1
    this.canvas.height = 1
    const context = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    })
    if (!context) throw new Error('水波效果需要 WebGL2')
    this.gl = context
    this.canvas.addEventListener('webglcontextlost', this.contextLost)
    this.canvas.addEventListener('webglcontextrestored', this.contextRestored)
    this.reducedMotion.addEventListener('change', this.motionPreferenceChanged)
    this.initGL()
    if (map.isStyleLoaded()) this.addToMap()
    else map.once('load', this.addToMap)
  }

  private readonly addToMap = () => {
    if (this.destroyed || this.added) return
    const coordinates = this.field
      ? waterCanvasCoordinates(this.field)
      : placeholderCoordinates(this.map)
    this.map.addSource(this.sourceId, {
      type: 'canvas',
      canvas: this.canvas,
      animate: false,
      coordinates,
    })
    this.map.addLayer({
      id: this.id,
      type: 'raster',
      source: this.sourceId,
      paint: {
        'raster-opacity': 1,
        'raster-fade-duration': 0,
        'raster-resampling': 'linear',
      },
    })
    this.added = true
    this.commitCanvas()
  }

  setField(field: FlowField | null) {
    const previous = this.field
    this.field = field
    if (!field) {
      this.clearTextures()
      this.clearCanvas()
      const container = this.map.getContainer()
      delete container.dataset.waterRipple
      delete container.dataset.waterRenderer
      delete container.dataset.waterColorize
      delete container.dataset.waterQuantity
      this.cancelRepaint()
      this.commitCanvas()
      return
    }

    const [width, height] = waterCanvasSize(field)
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    const sameGrid = previous != null && sameFlowGrid(previous, field)
    this.fadeStartedAt = performance.now()
    this.upload(field, sameGrid && this.animated)
    if (this.added) {
      const source = this.map.getSource(this.sourceId) as CanvasSource | undefined
      source?.setCoordinates(waterCanvasCoordinates(field))
    }
    const container = this.map.getContainer()
    container.dataset.waterRipple = 'active'
    container.dataset.waterRenderer = 'terrain-draped'
    this.drawFrame()
    this.scheduleRepaint()
  }

  setAnimated(animated: boolean) {
    if (this.animated === animated) return
    this.animated = animated
    if (!animated) {
      this.cancelRepaint()
      if (this.resources?.previous) {
        this.gl.deleteTexture(this.resources.previous)
        this.resources.previous = null
      }
    }
    this.drawFrame()
    this.scheduleRepaint()
  }

  setColorize(colorize: boolean) {
    if (this.colorize === colorize) return
    this.colorize = colorize
    this.updateDataset()
    this.drawFrame()
  }

  setQuantity(quantity: ResultQuantity) {
    if (this.quantity === quantity) return
    this.quantity = quantity
    this.updateDataset()
    this.drawFrame()
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
    if (this.map.getSource(this.sourceId)) this.map.removeSource(this.sourceId)
    this.added = false
    this.releaseGL()
    const container = this.map.getContainer()
    delete container.dataset.waterRipple
    delete container.dataset.waterRenderer
    delete container.dataset.waterColorize
    delete container.dataset.waterQuantity
    this.canvas.removeEventListener('webglcontextlost', this.contextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.contextRestored)
    this.reducedMotion.removeEventListener('change', this.motionPreferenceChanged)
  }

  private initGL() {
    this.releaseGL()
    const gl = this.gl
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
    const quad = mustCreate(gl.createBuffer(), '画布缓冲')
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    // Clip-space x/y followed by field u/v. Canvas top is north (v=0).
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 1,
      1, -1, 1, 1,
      -1, 1, 0, 0,
      -1, 1, 0, 0,
      1, -1, 1, 1,
      1, 1, 1, 0,
    ]), gl.STATIC_DRAW)
    this.resources = {
      program,
      quad,
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
    const resources = this.resources
    if (!resources || this.gl.isContextLost()) {
      this.resources = null
      return
    }
    if (resources.current) this.gl.deleteTexture(resources.current)
    if (resources.previous) this.gl.deleteTexture(resources.previous)
    this.gl.deleteBuffer(resources.quad)
    this.gl.deleteProgram(resources.program)
    this.resources = null
  }

  private upload(field: FlowField, keepPrevious: boolean) {
    const resources = this.resources
    if (!resources || this.gl.isContextLost()) return
    const gl = this.gl
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
  }

  private clearTextures() {
    const resources = this.resources
    if (!resources || this.gl.isContextLost()) return
    if (resources.current) this.gl.deleteTexture(resources.current)
    if (resources.previous) this.gl.deleteTexture(resources.previous)
    resources.current = null
    resources.previous = null
  }

  private clearCanvas() {
    if (this.gl.isContextLost()) return
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    this.gl.clearColor(0, 0, 0, 0)
    this.gl.clear(this.gl.COLOR_BUFFER_BIT)
    this.gl.flush()
  }

  private drawFrame() {
    const resources = this.resources
    const field = this.field
    if (!resources || !resources.current || !field || this.gl.isContextLost()) return
    const gl = this.gl
    const now = performance.now()
    const fade = this.animated && resources.previous
      ? crossfadeWeight(now - this.fadeStartedAt, this.reducedMotion.matches)
      : 1
    if (fade >= 1 && resources.previous) {
      gl.deleteTexture(resources.previous)
      resources.previous = null
    }
    const time = this.reducedMotion.matches || !this.animated ? 0 : (now - this.startedAt) / 1000
    const params = waterRippleParams
    const sun = sunDirection(params.sunAzimuth, params.sunElevation)
    const cellMeters = cellSizeMeters(field)
    const { program, uniforms } = resources

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.colorMask(true, true, true, true)
    gl.disable(gl.BLEND)
    gl.disable(gl.CULL_FACE)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.STENCIL_TEST)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(program)
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
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.quad)
    gl.enableVertexAttribArray(resources.attributes.position)
    gl.vertexAttribPointer(resources.attributes.position, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(resources.attributes.uv)
    gl.vertexAttribPointer(resources.attributes.uv, 2, gl.FLOAT, false, 16, 8)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.flush()
    this.commitCanvas()
  }

  private commitCanvas() {
    if (!this.added) return
    const source = this.map.getSource(this.sourceId) as CanvasSource | undefined
    if (source?.play && source.pause) {
      // CanvasSource only uploads changed pixels while playing. A synchronous
      // play/pause performs exactly one public, terrain-aware texture update.
      source.play()
      source.pause()
    }
    this.map.triggerRepaint()
  }

  private scheduleRepaint() {
    if (!this.animated || this.reducedMotion.matches || !this.field || this.repaintTimer != null) return
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = null
      if (!this.field || this.destroyed) return
      this.drawFrame()
      this.scheduleRepaint()
    }, REPAINT_MS)
  }

  private cancelRepaint() {
    if (this.repaintTimer != null) clearTimeout(this.repaintTimer)
    this.repaintTimer = null
  }

  private readonly motionPreferenceChanged = () => {
    if (this.reducedMotion.matches) this.cancelRepaint()
    this.drawFrame()
    this.scheduleRepaint()
  }

  private readonly contextLost = (event: Event) => {
    event.preventDefault()
    this.resources = null
    this.cancelRepaint()
  }

  private readonly contextRestored = () => {
    if (this.destroyed) return
    this.initGL()
    if (this.field) this.upload(this.field, false)
    this.drawFrame()
    this.scheduleRepaint()
  }
}

function placeholderCoordinates(map: Map) {
  const center = map.getCenter()
  // Keep the placeholder footprint large enough that ImageSource does not
  // derive a tile zoom beyond MapLibre's z25 limit before the field arrives.
  const delta = 0.005
  return [
    [center.lng - delta, center.lat + delta],
    [center.lng + delta, center.lat + delta],
    [center.lng + delta, center.lat - delta],
    [center.lng - delta, center.lat - delta],
  ] as [[number, number], [number, number], [number, number], [number, number]]
}

function sameFlowGrid(left: FlowField, right: FlowField) {
  if (left.width !== right.width || left.height !== right.height) return false
  const leftCoordinates = waterCanvasCoordinates(left)
  const rightCoordinates = waterCanvasCoordinates(right)
  return leftCoordinates.every((coordinate, index) => (
    coordinate[0] === rightCoordinates[index][0]
    && coordinate[1] === rightCoordinates[index][1]
  ))
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
