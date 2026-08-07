import type { FlowField, FlowGridCorners } from '../api/types'
import type { DensePreviewGrid, PreviewSnapshot, PreviewSolver } from './types'
import { PREVIEW_DRY_DEPTH_M, PREVIEW_GRAVITY_MPS2 } from './types'

const CFL = 0.42
const EPSILON = 1e-6

type Triple = [number, number, number]

/**
 * Small CPU implementation of the same regular-grid equations as the GPU
 * preview. It is intentionally boring: it is the executable numerical
 * contract used to test shader updates without requiring a browser.
 */
export class ReferencePreviewSolver implements PreviewSolver {
  readonly grid: DensePreviewGrid
  private state: Float32Array
  private appliedInputVolumeM3 = 0

  constructor(grid: DensePreviewGrid) {
    this.grid = grid
    this.state = new Float32Array(grid.initialState)
  }

  reset() {
    this.state.set(this.grid.initialState)
    this.appliedInputVolumeM3 = 0
  }

  recommendedTimeStepSeconds() {
    let maxWaveSpeed = EPSILON
    for (let cell = 0; cell < this.grid.mask.length; cell += 1) {
      if (this.grid.mask[cell] !== 1) continue
      const h = Math.max(0, this.state[cell * 4])
      const speed = h >= PREVIEW_DRY_DEPTH_M
        ? Math.hypot(this.state[cell * 4 + 1], this.state[cell * 4 + 2]) / h
        : 0
      maxWaveSpeed = Math.max(maxWaveSpeed, speed + Math.sqrt(PREVIEW_GRAVITY_MPS2 * h))
    }
    return Math.min(1, CFL * this.grid.cellSizeM / maxWaveSpeed)
  }

  step(timeStepSeconds: number, rainfallRateMps: number) {
    const width = this.grid.width
    const height = this.grid.height
    const dx = this.grid.cellSizeM
    const next = new Float32Array(this.state.length)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const cell = y * width + x
        if (this.grid.mask[cell] !== 1) continue
        const here = readState(this.state, cell)
        const right = this.interfaceFlux(x, y, 'right', here)
        const left = this.interfaceFlux(x, y, 'left', here)
        const north = this.interfaceFlux(x, y, 'north', here)
        const south = this.interfaceFlux(x, y, 'south', here)
        let h = here[0] - timeStepSeconds / dx * (right[0] - left[0] + north[0] - south[0])
        let qx = here[1] - timeStepSeconds / dx * (right[1] - left[1] + north[1] - south[1])
        let qy = here[2] - timeStepSeconds / dx * (right[2] - left[2] + north[2] - south[2])
        const terrainGradient = terrainGradientAt(this.grid, x, y)
        h = Math.max(0, h + timeStepSeconds * (rainfallRateMps + this.grid.inletDepthRateMps[cell]))
        qx += timeStepSeconds * (
          this.grid.inletXMomentumRate[cell] - PREVIEW_GRAVITY_MPS2 * h * terrainGradient[0]
        )
        qy += timeStepSeconds * (
          this.grid.inletYMomentumRate[cell] - PREVIEW_GRAVITY_MPS2 * h * terrainGradient[1]
        )
        if (h < PREVIEW_DRY_DEPTH_M) {
          qx = 0
          qy = 0
        } else {
          const n = Math.max(0, this.grid.manningN[cell])
          const speed = Math.hypot(qx, qy) / h
          const friction = timeStepSeconds * PREVIEW_GRAVITY_MPS2 * n * n * speed
            / Math.max(h ** (4 / 3), EPSILON)
          const scale = 1 / (1 + friction)
          qx *= scale
          qy *= scale
        }
        next[cell * 4] = h
        next[cell * 4 + 1] = qx
        next[cell * 4 + 2] = qy
        next[cell * 4 + 3] = 1
      }
    }
    this.state = next
    this.appliedInputVolumeM3 += (
      this.grid.inletDischargeM3s + rainfallRateMps * this.grid.activeAreaM2
    ) * timeStepSeconds
  }

  snapshot(timeSeconds: number): PreviewSnapshot {
    return makeSnapshot(this.grid, this.state, timeSeconds, this.appliedInputVolumeM3, 0)
  }

  dispose() {
    this.state = new Float32Array(0)
  }

  readState(cell: number): Triple {
    return readState(this.state, cell)
  }

  private interfaceFlux(
    x: number,
    y: number,
    direction: 'right' | 'left' | 'north' | 'south',
    here: Triple,
  ): Triple {
    const [dx, dy] = direction === 'right' ? [1, 0]
      : direction === 'left' ? [-1, 0]
        : direction === 'north' ? [0, 1] : [0, -1]
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || nx >= this.grid.width || ny < 0 || ny >= this.grid.height) {
      return openBoundaryFlux(here, direction)
    }
    const neighbourCell = ny * this.grid.width + nx
    const mask = this.grid.mask[neighbourCell]
    if (mask < 0) return wallFlux(here, direction)
    if (mask === 0) return openBoundaryFlux(here, direction)
    const neighbour = readState(this.state, neighbourCell)
    return rusanovFlux(
      direction === 'right' || direction === 'left' ? 'x' : 'y',
      direction === 'left' || direction === 'south' ? neighbour : here,
      direction === 'left' || direction === 'south' ? here : neighbour,
    )
  }
}

function readState(state: Float32Array, cell: number): Triple {
  return [state[cell * 4], state[cell * 4 + 1], state[cell * 4 + 2]]
}

function rusanovFlux(axis: 'x' | 'y', left: Triple, right: Triple): Triple {
  const leftFlux = physicalFlux(axis, left)
  const rightFlux = physicalFlux(axis, right)
  const leftSpeed = waveSpeed(axis, left)
  const rightSpeed = waveSpeed(axis, right)
  const alpha = Math.max(leftSpeed, rightSpeed)
  return [
    0.5 * (leftFlux[0] + rightFlux[0]) - 0.5 * alpha * (right[0] - left[0]),
    0.5 * (leftFlux[1] + rightFlux[1]) - 0.5 * alpha * (right[1] - left[1]),
    0.5 * (leftFlux[2] + rightFlux[2]) - 0.5 * alpha * (right[2] - left[2]),
  ]
}

function physicalFlux(axis: 'x' | 'y', state: Triple): Triple {
  const h = Math.max(0, state[0])
  const qx = state[1]
  const qy = state[2]
  const pressure = 0.5 * PREVIEW_GRAVITY_MPS2 * h * h
  if (axis === 'x') return [qx, qx * qx / Math.max(h, EPSILON) + pressure, qx * qy / Math.max(h, EPSILON)]
  return [qy, qx * qy / Math.max(h, EPSILON), qy * qy / Math.max(h, EPSILON) + pressure]
}

function waveSpeed(axis: 'x' | 'y', state: Triple) {
  const h = Math.max(0, state[0])
  const momentum = axis === 'x' ? state[1] : state[2]
  return Math.abs(momentum) / Math.max(h, EPSILON) + Math.sqrt(PREVIEW_GRAVITY_MPS2 * h)
}

function openBoundaryFlux(state: Triple, direction: 'right' | 'left' | 'north' | 'south'): Triple {
  const outward = direction === 'right' ? state[1] > 0
    : direction === 'left' ? state[1] < 0
      : direction === 'north' ? state[2] > 0 : state[2] < 0
  if (!outward) return [0, 0, 0]
  return physicalFlux(direction === 'right' || direction === 'left' ? 'x' : 'y', state)
}

function wallFlux(state: Triple, direction: 'right' | 'left' | 'north' | 'south'): Triple {
  const pressure = 0.5 * PREVIEW_GRAVITY_MPS2 * Math.max(0, state[0]) ** 2
  return direction === 'right' || direction === 'left' ? [0, pressure, 0] : [0, 0, pressure]
}

function terrainGradientAt(grid: DensePreviewGrid, x: number, y: number): [number, number] {
  const cell = y * grid.width + x
  const here = finiteTerrain(grid.elevationM[cell])
  const west = neighbourTerrain(grid, x - 1, y, here)
  const east = neighbourTerrain(grid, x + 1, y, here)
  const south = neighbourTerrain(grid, x, y - 1, here)
  const north = neighbourTerrain(grid, x, y + 1, here)
  return [(east - west) / (2 * grid.cellSizeM), (north - south) / (2 * grid.cellSizeM)]
}

function neighbourTerrain(grid: DensePreviewGrid, x: number, y: number, fallback: number) {
  if (x < 0 || x >= grid.width || y < 0 || y >= grid.height) return fallback
  const index = y * grid.width + x
  return grid.mask[index] === 1 ? finiteTerrain(grid.elevationM[index]) : fallback
}

function finiteTerrain(value: number) {
  return Number.isFinite(value) ? value : 0
}

function makeSnapshot(
  grid: DensePreviewGrid,
  state: Float32Array,
  timeSeconds: number,
  appliedInputVolumeM3: number,
  simulatedSecondsPerRealSecond: number,
): PreviewSnapshot {
  const cellCount = grid.width * grid.height
  const vectors = new Float32Array(cellCount * 2)
  const depths = new Float32Array(cellCount)
  const texels = new Uint16Array(cellCount * 4)
  const cellAreaM2 = grid.cellSizeM ** 2
  let waterVolumeM3 = 0
  let maximumDepthM = 0
  let maximumSpeedMps = 0
  let wetCellCount = 0
  for (let cell = 0; cell < cellCount; cell += 1) {
    const h = grid.mask[cell] === 1 ? Math.max(0, state[cell * 4]) : 0
    const qx = state[cell * 4 + 1]
    const qy = state[cell * 4 + 2]
    const speed = h >= PREVIEW_DRY_DEPTH_M ? Math.hypot(qx, qy) / h : 0
    const row = Math.floor(cell / grid.width)
    const column = cell % grid.width
    const displayCell = (grid.height - 1 - row) * grid.width + column
    vectors[displayCell * 2] = Number.isFinite(speed) ? qx / Math.max(h, PREVIEW_DRY_DEPTH_M) : 0
    vectors[displayCell * 2 + 1] = Number.isFinite(speed) ? qy / Math.max(h, PREVIEW_DRY_DEPTH_M) : 0
    depths[displayCell] = h >= PREVIEW_DRY_DEPTH_M ? h : Number.NaN
    const textureOffset = displayCell * 4
    texels[textureOffset] = encodeFloat16(vectors[displayCell * 2])
    texels[textureOffset + 1] = encodeFloat16(vectors[displayCell * 2 + 1])
    texels[textureOffset + 2] = encodeFloat16(h >= PREVIEW_DRY_DEPTH_M ? h : -1)
    texels[textureOffset + 3] = encodeFloat16(finiteTerrain(grid.elevationM[cell]) + h)
    if (grid.mask[cell] === 1) waterVolumeM3 += h * cellAreaM2
    if (h > maximumDepthM) maximumDepthM = h
    if (speed > maximumSpeedMps) maximumSpeedMps = speed
    if (h >= PREVIEW_DRY_DEPTH_M) wetCellCount += 1
  }
  const bounds: [number, number, number, number] = [
    Math.min(...grid.corners.map((corner) => corner[0])),
    Math.min(...grid.corners.map((corner) => corner[1])),
    Math.max(...grid.corners.map((corner) => corner[0])),
    Math.max(...grid.corners.map((corner) => corner[1])),
  ]
  const field: FlowField = {
    width: grid.width,
    height: grid.height,
    bounds,
    corners: grid.corners.map((corner) => [...corner]) as FlowGridCorners,
    vectors,
    depths: null,
    texels,
  }
  return {
    timeSeconds,
    field,
    diagnostics: {
      timeStepSeconds: 0,
      waterVolumeM3,
      appliedInputVolumeM3,
      maximumDepthM,
      maximumSpeedMps,
      wetCellCount,
      simulatedSecondsPerRealSecond,
    },
  }
}

function encodeFloat16(value: number) {
  if (!Number.isFinite(value)) return value < 0 ? 0xfc00 : 0x7c00
  const sign = value < 0 ? 0x8000 : 0
  const absolute = Math.abs(value)
  if (absolute === 0) return sign
  if (absolute >= 65504) return sign | 0x7bff
  const exponent = Math.floor(Math.log2(absolute))
  if (exponent < -14) return sign | Math.round(absolute / 2 ** -24)
  const fraction = Math.round((absolute / 2 ** exponent - 1) * 1024)
  const normalizedExponent = exponent + 15
  if (fraction === 1024) return sign | ((normalizedExponent + 1) << 10)
  return sign | (normalizedExponent << 10) | fraction
}

export { makeSnapshot }
