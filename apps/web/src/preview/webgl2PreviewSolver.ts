import type { PreviewSnapshot, PreviewSolver, DensePreviewGrid } from './types'
import { PREVIEW_DRY_DEPTH_M, PREVIEW_GRAVITY_MPS2 } from './types'
import { makeSnapshot } from './referencePreviewSolver'

const VERTEX_SHADER = `#version 300 es
precision highp float;
const vec2 POSITIONS[6] = vec2[6](
  vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
  vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0)
);
void main() { gl_Position = vec4(POSITIONS[gl_VertexID], 0.0, 1.0); }
`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_state;
uniform sampler2D u_terrain;
uniform sampler2D u_friction;
uniform sampler2D u_mask;
uniform sampler2D u_source;
uniform float u_dt;
uniform float u_rain;
uniform float u_dx;
uniform float u_gravity;
out vec4 outputState;
const float EPSILON = 0.000001;
const float DRY = 0.01;

ivec2 herePixel() { return ivec2(gl_FragCoord.xy); }
vec4 readState(ivec2 pixel) { return texelFetch(u_state, pixel, 0); }
float readMask(ivec2 pixel) {
  ivec2 size = textureSize(u_mask, 0);
  if (pixel.x < 0 || pixel.y < 0 || pixel.x >= size.x || pixel.y >= size.y) return 0.0;
  return texelFetch(u_mask, pixel, 0).r;
}
float readTerrain(ivec2 pixel, float fallback) {
  ivec2 size = textureSize(u_terrain, 0);
  if (pixel.x < 0 || pixel.y < 0 || pixel.x >= size.x || pixel.y >= size.y) return fallback;
  if (readMask(pixel) != 1.0) return fallback;
  float value = texelFetch(u_terrain, pixel, 0).r;
  return isnan(value) ? fallback : value;
}
vec3 physicalFlux(vec3 state, int axis) {
  float h = max(state.x, 0.0);
  float qx = state.y;
  float qy = state.z;
  float pressure = 0.5 * u_gravity * h * h;
  float inverseH = 1.0 / max(h, EPSILON);
  if (axis == 0) return vec3(qx, qx * qx * inverseH + pressure, qx * qy * inverseH);
  return vec3(qy, qx * qy * inverseH, qy * qy * inverseH + pressure);
}
float waveSpeed(vec3 state, int axis) {
  float h = max(state.x, 0.0);
  float momentum = axis == 0 ? state.y : state.z;
  return abs(momentum) / max(h, EPSILON) + sqrt(u_gravity * h);
}
vec3 wallFlux(vec3 state, int axis) {
  float pressure = 0.5 * u_gravity * max(state.x, 0.0) * max(state.x, 0.0);
  return axis == 0 ? vec3(0.0, pressure, 0.0) : vec3(0.0, 0.0, pressure);
}
vec3 openFlux(vec3 state, int axis, int direction) {
  float outward = axis == 0
    ? (direction > 0 ? state.y : -state.y)
    : (direction > 0 ? state.z : -state.z);
  return outward > 0.0 ? physicalFlux(state, axis) : vec3(0.0);
}
vec3 rusanov(vec3 left, vec3 right, int axis) {
  vec3 leftFlux = physicalFlux(left, axis);
  vec3 rightFlux = physicalFlux(right, axis);
  float alpha = max(waveSpeed(left, axis), waveSpeed(right, axis));
  return 0.5 * (leftFlux + rightFlux) - 0.5 * alpha * (right - left);
}
vec3 reconstructState(vec3 state, float terrain, float interfaceTerrain) {
  float h = max(state.x, 0.0);
  float reconstructedH = max(0.0, h + terrain - interfaceTerrain);
  if (h <= EPSILON || reconstructedH <= 0.0) return vec3(0.0);
  return vec3(reconstructedH, state.yz * (reconstructedH / h));
}
vec3 hydrostaticFlux(
  vec3 left, vec3 right, float leftTerrain, float rightTerrain, int axis, bool hereIsLeft
) {
  float interfaceTerrain = max(leftTerrain, rightTerrain);
  vec3 reconstructedLeft = reconstructState(left, leftTerrain, interfaceTerrain);
  vec3 reconstructedRight = reconstructState(right, rightTerrain, interfaceTerrain);
  vec3 flux = rusanov(reconstructedLeft, reconstructedRight, axis);
  vec3 here = hereIsLeft ? left : right;
  vec3 reconstructedHere = hereIsLeft ? reconstructedLeft : reconstructedRight;
  float correction = 0.5 * u_gravity * (
    max(here.x, 0.0) * max(here.x, 0.0) - reconstructedHere.x * reconstructedHere.x
  );
  if (axis == 0) flux.y += correction;
  else flux.z += correction;
  return flux;
}
vec3 interfaceFlux(ivec2 pixel, ivec2 neighbour, vec3 here, int axis, int direction) {
  ivec2 size = textureSize(u_state, 0);
  if (neighbour.x < 0 || neighbour.y < 0 || neighbour.x >= size.x || neighbour.y >= size.y) {
    return openFlux(here, axis, direction);
  }
  float neighbourMask = readMask(neighbour);
  if (neighbourMask < -0.5) return wallFlux(here, axis);
  if (neighbourMask < 0.5) return openFlux(here, axis, direction);
  vec3 neighbourState = readState(neighbour).xyz;
  float hereTerrain = readTerrain(pixel, 0.0);
  float neighbourTerrain = readTerrain(neighbour, hereTerrain);
  return direction < 0
    ? hydrostaticFlux(neighbourState, here, neighbourTerrain, hereTerrain, axis, false)
    : hydrostaticFlux(here, neighbourState, hereTerrain, neighbourTerrain, axis, true);
}

void main() {
  ivec2 pixel = herePixel();
  float mask = readMask(pixel);
  if (mask != 1.0) {
    outputState = vec4(0.0);
    return;
  }
  vec3 here = readState(pixel).xyz;
  vec3 right = interfaceFlux(pixel, pixel + ivec2(1, 0), here, 0, 1);
  vec3 left = interfaceFlux(pixel, pixel + ivec2(-1, 0), here, 0, -1);
  vec3 north = interfaceFlux(pixel, pixel + ivec2(0, 1), here, 1, 1);
  vec3 south = interfaceFlux(pixel, pixel + ivec2(0, -1), here, 1, -1);
  float dtOverDx = u_dt / u_dx;
  float h = here.x - dtOverDx * (right.x - left.x + north.x - south.x);
  float qx = here.y - dtOverDx * (right.y - left.y + north.y - south.y);
  float qy = here.z - dtOverDx * (right.z - left.z + north.z - south.z);

  vec3 source = texelFetch(u_source, pixel, 0).rgb;
  h = max(0.0, h + u_dt * (source.r + u_rain));
  qx += u_dt * source.g;
  qy += u_dt * source.b;

  if (h < DRY) {
    qx = 0.0;
    qy = 0.0;
  } else {
    float n = max(0.0, texelFetch(u_friction, pixel, 0).r);
    float speed = length(vec2(qx, qy)) / max(h, EPSILON);
    float friction = u_dt * u_gravity * n * n * speed / max(pow(h, 1.3333333), EPSILON);
    float scale = 1.0 / (1.0 + friction);
    qx *= scale;
    qy *= scale;
  }
  outputState = vec4(h, qx, qy, 1.0);
}
`

interface TextureSet {
  state: WebGLTexture
  terrain: WebGLTexture
  friction: WebGLTexture
  mask: WebGLTexture
  source: WebGLTexture
}

interface GpuResources {
  program: WebGLProgram
  framebuffer: WebGLFramebuffer
  quad: WebGLVertexArrayObject
  uniforms: Record<string, WebGLUniformLocation | null>
  read: WebGLTexture
  write: WebGLTexture
  inputs: TextureSet
}

export class WebGL2PreviewSolver implements PreviewSolver {
  readonly grid: DensePreviewGrid
  private readonly canvas: HTMLCanvasElement
  private readonly gl: WebGL2RenderingContext
  private resources: GpuResources
  private statePixels: Float32Array
  private appliedInputVolumeM3 = 0
  private maxWaveSpeed = 1
  private disposed = false

  constructor(grid: DensePreviewGrid) {
    this.grid = grid
    this.canvas = document.createElement('canvas')
    this.canvas.width = grid.width
    this.canvas.height = grid.height
    const gl = this.canvas.getContext('webgl2', {
      antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false,
    })
    if (!(gl instanceof WebGL2RenderingContext)) throw new Error('快速预览需要 WebGL2')
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('显卡不支持浮点预览纹理')
    this.gl = gl
    this.resources = this.createResources()
    this.statePixels = new Float32Array(grid.initialState)
    this.uploadState(this.resources.read, this.statePixels)
    this.uploadState(this.resources.write, null)
  }

  reset() {
    this.assertAlive()
    this.statePixels.set(this.grid.initialState)
    this.uploadState(this.resources.read, this.statePixels)
    this.uploadState(this.resources.write, null)
    this.appliedInputVolumeM3 = 0
    this.maxWaveSpeed = 1
  }

  recommendedTimeStepSeconds() {
    return Math.min(1, 0.42 * this.grid.cellSizeM / Math.max(this.maxWaveSpeed, 1e-6))
  }

  step(timeStepSeconds: number, rainfallRateMps: number) {
    this.assertAlive()
    const { gl, resources } = this
    gl.bindFramebuffer(gl.FRAMEBUFFER, resources.framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resources.write, 0)
    gl.viewport(0, 0, this.grid.width, this.grid.height)
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.useProgram(resources.program)
    gl.bindVertexArray(resources.quad)
    gl.uniform1f(resources.uniforms.u_dt, timeStepSeconds)
    gl.uniform1f(resources.uniforms.u_rain, rainfallRateMps)
    gl.uniform1f(resources.uniforms.u_dx, this.grid.cellSizeM)
    gl.uniform1f(resources.uniforms.u_gravity, PREVIEW_GRAVITY_MPS2)
    bindTexture(gl, resources.read, 0, resources.uniforms.u_state)
    bindTexture(gl, resources.inputs.terrain, 1, resources.uniforms.u_terrain)
    bindTexture(gl, resources.inputs.friction, 2, resources.uniforms.u_friction)
    bindTexture(gl, resources.inputs.mask, 3, resources.uniforms.u_mask)
    bindTexture(gl, resources.inputs.source, 4, resources.uniforms.u_source)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.bindVertexArray(null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const old = resources.read
    resources.read = resources.write
    resources.write = old
    this.appliedInputVolumeM3 += (
      this.grid.inletDischargeM3s + rainfallRateMps * this.grid.activeAreaM2
    ) * timeStepSeconds
  }

  snapshot(timeSeconds: number): PreviewSnapshot {
    this.assertAlive()
    const { gl, resources } = this
    gl.bindFramebuffer(gl.FRAMEBUFFER, resources.framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resources.read, 0)
    gl.readPixels(0, 0, this.grid.width, this.grid.height, gl.RGBA, gl.FLOAT, this.statePixels)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (gl.getError() !== gl.NO_ERROR) throw new Error('快速预览无法读取 GPU 状态')
    let maxWaveSpeed = 1e-6
    for (let cell = 0; cell < this.grid.mask.length; cell += 1) {
      if (this.grid.mask[cell] !== 1) continue
      const h = Math.max(0, this.statePixels[cell * 4])
      const speed = h >= PREVIEW_DRY_DEPTH_M
        ? Math.hypot(this.statePixels[cell * 4 + 1], this.statePixels[cell * 4 + 2]) / h : 0
      maxWaveSpeed = Math.max(maxWaveSpeed, speed + Math.sqrt(PREVIEW_GRAVITY_MPS2 * h))
    }
    this.maxWaveSpeed = maxWaveSpeed
    const result = makeSnapshot(this.grid, this.statePixels, timeSeconds, this.appliedInputVolumeM3, 0)
    result.diagnostics.timeStepSeconds = this.recommendedTimeStepSeconds()
    return result
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    const { gl, resources } = this
    if (gl.isContextLost()) return
    gl.deleteTexture(resources.read)
    gl.deleteTexture(resources.write)
    gl.deleteTexture(resources.inputs.terrain)
    gl.deleteTexture(resources.inputs.friction)
    gl.deleteTexture(resources.inputs.mask)
    gl.deleteTexture(resources.inputs.source)
    gl.deleteFramebuffer(resources.framebuffer)
    gl.deleteVertexArray(resources.quad)
    gl.deleteProgram(resources.program)
    this.statePixels = new Float32Array(0)
  }

  private createResources(): GpuResources {
    const gl = this.gl
    const program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER)
    const quad = required(gl.createVertexArray(), '预览顶点数组')
    const framebuffer = required(gl.createFramebuffer(), '预览帧缓冲')
    const read = createFloatTexture(gl, this.grid.width, this.grid.height, this.grid.initialState)
    const write = createFloatTexture(gl, this.grid.width, this.grid.height, null)
    const terrain = createScalarTexture(gl, this.grid.width, this.grid.height, this.grid.elevationM)
    const friction = createScalarTexture(gl, this.grid.width, this.grid.height, this.grid.manningN)
    const mask = createScalarTexture(gl, this.grid.width, this.grid.height, this.grid.mask)
    const source = createFloatTexture(gl, this.grid.width, this.grid.height, sourcePixels(this.grid))
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, read, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('快速预览浮点帧缓冲不完整')
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const uniforms: Record<string, WebGLUniformLocation | null> = {}
    for (const name of ['u_state', 'u_terrain', 'u_friction', 'u_mask', 'u_source', 'u_dt', 'u_rain', 'u_dx', 'u_gravity']) {
      uniforms[name] = gl.getUniformLocation(program, name)
    }
    return {
      program, framebuffer, quad, uniforms, read, write,
      inputs: { state: read, terrain, friction, mask, source },
    }
  }

  private uploadState(texture: WebGLTexture, data: Float32Array | null) {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.grid.width, this.grid.height, 0, gl.RGBA, gl.FLOAT, data)
  }

  private assertAlive() {
    if (this.disposed || this.gl.isContextLost()) throw new Error('快速预览 GPU 上下文不可用')
  }
}

function sourcePixels(grid: DensePreviewGrid) {
  const pixels = new Float32Array(grid.width * grid.height * 4)
  for (let cell = 0; cell < grid.width * grid.height; cell += 1) {
    pixels[cell * 4] = grid.inletDepthRateMps[cell]
    pixels[cell * 4 + 1] = grid.inletXMomentumRate[cell]
    pixels[cell * 4 + 2] = grid.inletYMomentumRate[cell]
  }
  return pixels
}

function createFloatTexture(
  gl: WebGL2RenderingContext, width: number, height: number, data: Float32Array | null,
) {
  const texture = required(gl.createTexture(), '预览浮点纹理')
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data)
  return texture
}

function createScalarTexture(
  gl: WebGL2RenderingContext, width: number, height: number, data: Float32Array,
) {
  const texture = required(gl.createTexture(), '预览标量纹理')
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, data)
  return texture
}

function bindTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  unit: number,
  uniform: WebGLUniformLocation | null,
) {
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.uniform1i(uniform, unit)
}

function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string) {
  const compile = (type: number, source: string) => {
    const shader = required(gl.createShader(type), '预览 shader')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || '未知 shader 错误'
      gl.deleteShader(shader)
      throw new Error(`预览 shader 编译失败：${message}`)
    }
    return shader
  }
  const vertex = compile(gl.VERTEX_SHADER, vertexSource)
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource)
  const program = required(gl.createProgram(), '预览 shader 程序')
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || '未知链接错误'
    gl.deleteProgram(program)
    throw new Error(`预览 shader 链接失败：${message}`)
  }
  return program
}

function required<T>(value: T | null, name: string): T {
  if (value == null) throw new Error(`无法创建${name}`)
  return value
}
