import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map,
} from 'maplibre-gl'
import type { FlowField } from '../api/types'
import { advectGridPosition, gridUvToLngLat, lngLatToGridUv } from './flowGrid'

interface TrailPoint {
  longitude: number
  latitude: number
  altitude: number
}

interface Particle extends TrailPoint {
  ageSeconds: number
  trail: TrailPoint[]
}

interface ParticleSample {
  velocity: [number, number]
  depth: number
  stage: number | null
}

interface ParticleResources {
  program: WebGLProgram
  buffer: WebGLBuffer
  attributes: {
    start: number
    end: number
    t: number
    side: number
    alpha: number
    width: number
  }
  uniforms: {
    matrix: WebGLUniformLocation | null
    viewport: WebGLUniformLocation | null
  }
}

const MIN_SPEED_MPS = 0.03
const VISUAL_SECONDS_PER_SECOND = 180
const PARTICLE_MIN_AGE_SECONDS = 1.4
const PARTICLE_AGE_SPREAD_SECONDS = 3.2
const PARTICLE_DENSITY_PX = 700
const PARTICLE_MIN_COUNT = 80
const PARTICLE_MAX_COUNT = 700
const MAX_TRAIL_POINTS = 12
const WATER_SURFACE_OFFSET_M = 0.08
const VERTEX_FLOATS = 10
const REPAINT_MS = 33
let nextLayerId = 0

const VERTEX_SHADER = `
attribute vec3 a_start;
attribute vec3 a_end;
attribute float a_t;
attribute float a_side;
attribute float a_alpha;
attribute float a_width;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
varying float v_alpha;
void main() {
  vec4 start_clip = u_matrix * vec4(a_start, 1.0);
  vec4 end_clip = u_matrix * vec4(a_end, 1.0);
  vec2 start_ndc = start_clip.xy / start_clip.w;
  vec2 end_ndc = end_clip.xy / end_clip.w;
  vec2 screen_direction = (end_ndc - start_ndc) * u_viewport;
  float direction_length = length(screen_direction);
  vec2 normal = direction_length > 0.001
    ? vec2(-screen_direction.y, screen_direction.x) / direction_length
    : vec2(0.0, 1.0);
  gl_Position = mix(start_clip, end_clip, a_t);
  gl_Position.xy += normal * a_side * a_width * 2.0 / u_viewport * gl_Position.w;
  v_alpha = a_alpha;
}
`

const FRAGMENT_SHADER = `
precision mediump float;
varying float v_alpha;
void main() {
  float alpha = clamp(v_alpha, 0.0, 1.0);
  vec3 color = vec3(0.325, 0.906, 1.0);
  gl_FragColor = vec4(color * alpha, alpha);
}
`

/** Bilinearly sample velocity and water-surface values at a map position. */
export function sampleParticleField(
  field: FlowField,
  longitude: number,
  latitude: number,
): ParticleSample | null {
  const [uCoordinate, vCoordinate] = lngLatToGridUv(field, longitude, latitude)
  const gridX = uCoordinate * field.width - 0.5
  const gridY = vCoordinate * field.height - 0.5
  const column = Math.floor(gridX)
  const row = Math.floor(gridY)
  const fractionX = gridX - column
  const fractionY = gridY - row
  let u = 0
  let v = 0
  let depth = 0
  let stage = 0
  let stageWeight = 0
  let weightSum = 0
  for (let corner = 0; corner < 4; corner += 1) {
    const x = column + (corner & 1)
    const y = row + (corner >> 1)
    if (x < 0 || x >= field.width || y < 0 || y >= field.height) continue
    const weight = (corner & 1 ? fractionX : 1 - fractionX)
      * (corner >> 1 ? fractionY : 1 - fractionY)
    if (weight <= 0) continue
    const cell = y * field.width + x
    const cellU = field.vectors[cell * 2]
    const cellV = field.vectors[cell * 2 + 1]
    if (!Number.isFinite(cellU) || !Number.isFinite(cellV)) continue
    let cellDepth = field.depths?.[cell] ?? 0
    let cellStage: number | null = null
    if (field.texels) {
      cellDepth = decodeFloat16(field.texels[cell * 4 + 2])
      cellStage = decodeFloat16(field.texels[cell * 4 + 3])
      if (cellDepth < 0 || !Number.isFinite(cellStage)) continue
    } else if (field.depths && !Number.isFinite(cellDepth)) {
      continue
    }
    u += cellU * weight
    v += cellV * weight
    depth += cellDepth * weight
    if (cellStage != null) {
      stage += cellStage * weight
      stageWeight += weight
    }
    weightSum += weight
  }
  if (weightSum === 0) return null
  u /= weightSum
  v /= weightSum
  if (Math.hypot(u, v) < MIN_SPEED_MPS) return null
  return {
    velocity: [u, v],
    depth: depth / weightSum,
    stage: stageWeight > 0 ? stage / stageWeight : null,
  }
}

/** Position a particle at the simulation water surface under terrain exaggeration. */
export function particleSurfaceAltitude(
  sample: Pick<ParticleSample, 'depth' | 'stage'>,
  terrainElevation: number | null,
  terrainExaggeration: number,
) {
  if (sample.stage != null) {
    const ground = sample.stage - sample.depth
    return (terrainExaggeration > 0
      ? ground * terrainExaggeration + sample.depth
      : sample.stage) + WATER_SURFACE_OFFSET_M
  }
  return (terrainElevation ?? 0) + sample.depth + WATER_SURFACE_OFFSET_M
}

/**
 * Three-dimensional flow particles rendered inside MapLibre's WebGL pipeline.
 * Geographic trail endpoints are transformed with the authoritative custom-
 * layer matrix and share terrain's depth buffer, so camera pitch and altitude
 * cannot detach them from the water surface.
 */
export class FlowParticleLayer implements CustomLayerInterface {
  readonly id = `flow-particles-${nextLayerId++}`
  readonly type = 'custom' as const
  readonly renderingMode = '3d' as const
  private gl: WebGL2RenderingContext | null = null
  private resources: ParticleResources | null = null
  private particles: Particle[] = []
  private field: FlowField | null = null
  private wetCells: number[] = []
  private lastFrameTime = 0
  private terrainExaggeration = 0
  private frameIndex: number | null = null
  private repaintTimer: ReturnType<typeof setTimeout> | null = null
  private added = false
  private destroyed = false
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

  constructor(private readonly map: Map) {
    this.reducedMotion.addEventListener('change', this.motionPreferenceChanged)
    this.map.on('moveend', this.handleMoveEnd)
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
      throw new Error('三维流向粒子需要 WebGL2')
    }
    this.gl = context
    const vertex = compileShader(context, context.VERTEX_SHADER, VERTEX_SHADER)
    const fragment = compileShader(context, context.FRAGMENT_SHADER, FRAGMENT_SHADER)
    const program = mustCreate(context.createProgram(), '粒子 shader 程序')
    context.attachShader(program, vertex)
    context.attachShader(program, fragment)
    context.linkProgram(program)
    context.deleteShader(vertex)
    context.deleteShader(fragment)
    if (!context.getProgramParameter(program, context.LINK_STATUS)) {
      const log = context.getProgramInfoLog(program)
      context.deleteProgram(program)
      throw new Error(`流向粒子 shader 链接失败: ${log ?? '未知错误'}`)
    }
    this.resources = {
      program,
      buffer: mustCreate(context.createBuffer(), '粒子顶点缓冲'),
      attributes: {
        start: context.getAttribLocation(program, 'a_start'),
        end: context.getAttribLocation(program, 'a_end'),
        t: context.getAttribLocation(program, 'a_t'),
        side: context.getAttribLocation(program, 'a_side'),
        alpha: context.getAttribLocation(program, 'a_alpha'),
        width: context.getAttribLocation(program, 'a_width'),
      },
      uniforms: {
        matrix: context.getUniformLocation(program, 'u_matrix'),
        viewport: context.getUniformLocation(program, 'u_viewport'),
      },
    }
  }

  onRemove() {
    this.releaseGL()
    this.gl = null
    this.added = false
  }

  setField(field: FlowField | null, frameIndex: number | null) {
    const keepTrails = field != null
      && this.field != null
      && field.width === this.field.width
      && field.height === this.field.height
      && this.particles.length > 0
      && !this.reducedMotion.matches
    this.field = field
    this.frameIndex = frameIndex
    this.wetCells = field ? this.findWetCells(field) : []
    const container = this.map.getContainer()
    if (frameIndex == null) delete container.dataset.flowFrame
    else container.dataset.flowFrame = String(frameIndex)
    if (!field || this.wetCells.length === 0) {
      this.particles = []
      delete container.dataset.flowMode
      this.cancelRepaint()
      this.map.triggerRepaint()
      return
    }
    if (this.reducedMotion.matches) {
      container.dataset.flowMode = 'static'
      this.buildStaticParticles()
    } else {
      container.dataset.flowMode = 'animated'
      const count = this.desiredCount()
      if (keepTrails) {
        this.particles.length = Math.min(this.particles.length, count)
        while (this.particles.length < count) this.particles.push(this.spawn())
      } else {
        this.particles = []
        for (let index = 0; index < count; index += 1) {
          this.particles.push(this.spawn(index % this.wetCells.length))
        }
      }
      this.lastFrameTime = performance.now()
    }
    this.map.triggerRepaint()
  }

  setTerrainExaggeration(exaggeration: number) {
    const next = Math.max(0, exaggeration)
    if (next === this.terrainExaggeration) return
    this.terrainExaggeration = next
    // Existing trails were built at the old vertical scale. Dropping them is
    // preferable to showing a brief vertical jump when the user changes it.
    for (const particle of this.particles) {
      const sample = this.field
        ? sampleParticleField(this.field, particle.longitude, particle.latitude)
        : null
      if (!sample) continue
      particle.altitude = this.altitudeAt(particle.longitude, particle.latitude, sample)
      particle.trail = [{
        longitude: particle.longitude,
        latitude: particle.latitude,
        altitude: particle.altitude,
      }]
    }
    this.map.triggerRepaint()
  }

  destroy() {
    this.destroyed = true
    this.cancelRepaint()
    this.map.off('load', this.addToMap)
    this.map.off('moveend', this.handleMoveEnd)
    this.reducedMotion.removeEventListener('change', this.motionPreferenceChanged)
    if (this.map.getLayer(this.id)) this.map.removeLayer(this.id)
    else this.releaseGL()
    delete this.map.getContainer().dataset.flowMode
    delete this.map.getContainer().dataset.flowFrame
  }

  render(
    context: WebGLRenderingContext | WebGL2RenderingContext,
    options: CustomRenderMethodInput,
  ) {
    const resources = this.resources
    const field = this.field
    if (!resources || !field || this.particles.length === 0) return
    const now = performance.now()
    if (!this.reducedMotion.matches) {
      const elapsed = Math.min(Math.max((now - this.lastFrameTime) / 1000, 0), 0.08)
      this.lastFrameTime = now
      this.advance(elapsed)
    }
    const vertices = this.buildTrailVertices()
    if (vertices.length === 0) {
      this.scheduleRepaint()
      return
    }
    const gl = context as WebGL2RenderingContext
    gl.useProgram(resources.program)
    gl.uniformMatrix4fv(
      resources.uniforms.matrix,
      false,
      options.defaultProjectionData.mainMatrix,
    )
    gl.uniform2f(resources.uniforms.viewport, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW)
    const stride = VERTEX_FLOATS * 4
    enableAttribute(gl, resources.attributes.start, 3, stride, 0)
    enableAttribute(gl, resources.attributes.end, 3, stride, 12)
    enableAttribute(gl, resources.attributes.t, 1, stride, 24)
    enableAttribute(gl, resources.attributes.side, 1, stride, 28)
    enableAttribute(gl, resources.attributes.alpha, 1, stride, 32)
    enableAttribute(gl, resources.attributes.width, 1, stride, 36)
    gl.enable(gl.BLEND)
    // Match the former Canvas `lighter` composition so cyan trails remain
    // legible over the pale depth ramp.
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.disable(gl.CULL_FACE)
    gl.depthMask(false)
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / VERTEX_FLOATS)
    this.scheduleRepaint()
  }

  private advance(elapsed: number) {
    if (!this.field || elapsed <= 0) return
    const seconds = elapsed * VISUAL_SECONDS_PER_SECOND
    for (let index = 0; index < this.particles.length; index += 1) {
      let particle = this.particles[index]
      const sample = sampleParticleField(this.field, particle.longitude, particle.latitude)
      particle.ageSeconds -= elapsed
      if (!sample || particle.ageSeconds <= 0) {
        particle = this.spawn()
        this.particles[index] = particle
        continue
      }
      const [longitude, latitude] = advectGridPosition(
        this.field,
        particle.longitude,
        particle.latitude,
        sample.velocity,
        seconds,
      )
      const nextSample = sampleParticleField(this.field, longitude, latitude)
      if (!nextSample) {
        this.particles[index] = this.spawn()
        continue
      }
      particle.longitude = longitude
      particle.latitude = latitude
      particle.altitude = this.altitudeAt(longitude, latitude, nextSample)
      particle.trail.push({ longitude, latitude, altitude: particle.altitude })
      if (particle.trail.length > MAX_TRAIL_POINTS) particle.trail.shift()
    }
  }

  private buildTrailVertices() {
    let segmentCount = 0
    for (const particle of this.particles) segmentCount += Math.max(0, particle.trail.length - 1)
    const vertices = new Float32Array(segmentCount * 6 * VERTEX_FLOATS)
    let offset = 0
    for (const particle of this.particles) {
      for (let index = 1; index < particle.trail.length; index += 1) {
        const start = particle.trail[index - 1]
        const end = particle.trail[index]
        const startCoordinate = MercatorCoordinate.fromLngLat(
          [start.longitude, start.latitude], start.altitude,
        )
        const endCoordinate = MercatorCoordinate.fromLngLat(
          [end.longitude, end.latitude], end.altitude,
        )
        const progress = index / Math.max(1, particle.trail.length - 1)
        const alpha = 0.08 + progress * 0.5
        const width = 0.65 + progress * 0.8
        const corners: [number, number][] = [
          [0, -1], [0, 1], [1, -1],
          [1, -1], [0, 1], [1, 1],
        ]
        for (const [t, side] of corners) {
          vertices[offset++] = startCoordinate.x
          vertices[offset++] = startCoordinate.y
          vertices[offset++] = startCoordinate.z
          vertices[offset++] = endCoordinate.x
          vertices[offset++] = endCoordinate.y
          vertices[offset++] = endCoordinate.z
          vertices[offset++] = t
          vertices[offset++] = side
          vertices[offset++] = alpha
          vertices[offset++] = width
        }
      }
    }
    return vertices
  }

  private findWetCells(field: FlowField) {
    const cells: number[] = []
    for (let cell = 0; cell < field.width * field.height; cell += 1) {
      const u = field.vectors[cell * 2]
      const v = field.vectors[cell * 2 + 1]
      if (Number.isFinite(u) && Number.isFinite(v) && Math.hypot(u, v) >= MIN_SPEED_MPS) {
        cells.push(cell)
      }
    }
    return cells
  }

  private spawn(offset?: number): Particle {
    if (!this.field || this.wetCells.length === 0) {
      return { longitude: 0, latitude: 0, altitude: 0, ageSeconds: 0, trail: [] }
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const wetIndex = offset == null
        ? Math.floor(Math.random() * this.wetCells.length)
        : offset + attempt
      const cell = this.wetCells[wetIndex % this.wetCells.length]
      const row = Math.floor(cell / this.field.width)
      const column = cell % this.field.width
      const [longitude, latitude] = gridUvToLngLat(
        this.field,
        (column + Math.random()) / this.field.width,
        (row + Math.random()) / this.field.height,
      )
      const sample = sampleParticleField(this.field, longitude, latitude)
      if (!sample) continue
      const altitude = this.altitudeAt(longitude, latitude, sample)
      return {
        longitude,
        latitude,
        altitude,
        ageSeconds: PARTICLE_MIN_AGE_SECONDS + Math.random() * PARTICLE_AGE_SPREAD_SECONDS,
        trail: [{ longitude, latitude, altitude }],
      }
    }
    return { longitude: 0, latitude: 0, altitude: 0, ageSeconds: 0, trail: [] }
  }

  private altitudeAt(longitude: number, latitude: number, sample: ParticleSample) {
    const terrainElevation = sample.stage == null
      ? this.map.queryTerrainElevation([longitude, latitude])
      : null
    return particleSurfaceAltitude(sample, terrainElevation, this.terrainExaggeration)
  }

  private buildStaticParticles() {
    if (!this.field) return
    this.particles = []
    const stride = Math.max(1, Math.ceil(Math.sqrt(this.wetCells.length / 180)))
    for (let index = 0; index < this.wetCells.length; index += stride) {
      const particle = this.spawn(index)
      const sample = sampleParticleField(this.field, particle.longitude, particle.latitude)
      if (!sample) continue
      const seconds = 25
      const [longitude, latitude] = advectGridPosition(
        this.field,
        particle.longitude,
        particle.latitude,
        sample.velocity,
        seconds,
      )
      const endSample = sampleParticleField(this.field, longitude, latitude) ?? sample
      particle.trail.push({
        longitude,
        latitude,
        altitude: this.altitudeAt(longitude, latitude, endSample),
      })
      this.particles.push(particle)
    }
  }

  private desiredCount() {
    if (!this.field || this.wetCells.length === 0) return 0
    const topLeft = this.map.project(gridUvToLngLat(this.field, 0, 0))
    const bottomRight = this.map.project(gridUvToLngLat(this.field, 1, 1))
    const cellAreaPx = Math.abs(
      (bottomRight.x - topLeft.x) * (bottomRight.y - topLeft.y),
    ) / (this.field.width * this.field.height)
    if (!Number.isFinite(cellAreaPx) || cellAreaPx <= 0) {
      return Math.min(PARTICLE_MAX_COUNT, Math.max(PARTICLE_MIN_COUNT, this.wetCells.length * 2))
    }
    const wetPixels = this.wetCells.length * cellAreaPx
    return Math.round(Math.min(
      PARTICLE_MAX_COUNT,
      Math.max(PARTICLE_MIN_COUNT, wetPixels / PARTICLE_DENSITY_PX),
    ))
  }

  private readonly handleMoveEnd = () => {
    if (!this.field || this.reducedMotion.matches) return
    const target = this.desiredCount()
    this.particles.length = Math.min(this.particles.length, target)
    while (this.particles.length < target) this.particles.push(this.spawn())
  }

  private readonly motionPreferenceChanged = () => {
    this.setField(this.field, this.frameIndex)
  }

  private scheduleRepaint() {
    if (this.reducedMotion.matches || !this.field || this.repaintTimer != null) return
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = null
      if (this.field && !this.destroyed) this.map.triggerRepaint()
    }, REPAINT_MS)
  }

  private cancelRepaint() {
    if (this.repaintTimer != null) clearTimeout(this.repaintTimer)
    this.repaintTimer = null
  }

  private releaseGL() {
    const gl = this.gl
    const resources = this.resources
    if (!gl || !resources) return
    gl.deleteBuffer(resources.buffer)
    gl.deleteProgram(resources.program)
    this.resources = null
  }
}

function decodeFloat16(bits: number) {
  const sign = bits & 0x8000 ? -1 : 1
  const exponent = (bits >>> 10) & 0x1f
  const fraction = bits & 0x03ff
  if (exponent === 0) return sign * fraction * 2 ** -24
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15)
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = mustCreate(gl.createShader(type), '粒子 shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`流向粒子 shader 编译失败: ${log ?? '未知错误'}`)
  }
  return shader
}

function enableAttribute(
  gl: WebGL2RenderingContext,
  location: number,
  size: number,
  stride: number,
  offset: number,
) {
  gl.enableVertexAttribArray(location)
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset)
}

function mustCreate<T>(value: T | null, label: string): T {
  if (value == null) throw new Error(`流向粒子初始化失败: 无法创建${label}`)
  return value
}
