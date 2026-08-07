import type { Inlet, ScenarioPayload } from '../api/types'
import { parseCellId, type SimulationGrid } from '../map/simulationGrid'
import type { DensePreviewGrid } from './types'

const ACTIVE = 1
const EXTERIOR = 0
const SOLID_HOLE = -1
const MAX_DENSE_PREVIEW_CELLS = 1_048_576

export function buildDensePreviewGrid(
  source: SimulationGrid,
  scenario: ScenarioPayload,
  cellSizeM: number,
  maxTextureSize = Number.POSITIVE_INFINITY,
): DensePreviewGrid {
  const width = source.columnStop - source.columnStart
  const height = source.rowStop - source.rowStart
  if (
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width <= 0 || height <= 0
  ) throw new Error('快速预览网格范围无效')
  if (width > maxTextureSize || height > maxTextureSize) {
    throw new Error('计算区域超过当前显卡的预览纹理上限')
  }
  const length = width * height
  if (!Number.isSafeInteger(length) || length > MAX_DENSE_PREVIEW_CELLS) {
    throw new Error('快速预览稠密网格超过浏览器内存上限')
  }
  const mask = new Float32Array(length)
  mask.fill(SOLID_HOLE)
  const elevationM = new Float32Array(length)
  const manningN = new Float32Array(length)
  const inletDepthRateMps = new Float32Array(length)
  const inletXMomentumRate = new Float32Array(length)
  const inletYMomentumRate = new Float32Array(length)
  const initialState = new Float32Array(length * 4)
  elevationM.fill(Number.NaN)
  manningN.fill(Number.NaN)

  const manning = scenario.frictionScenario === 'low'
    ? source.manningLow
    : scenario.frictionScenario === 'middle'
      ? source.manningMiddle
      : source.manningHigh
  const denseByGlobal = new Map<number, number>()
  for (let position = 0; position < source.cellCount; position += 1) {
    const globalIndex = source.cellIndices[position]
    const row = Math.floor(globalIndex / source.demColumns)
    const column = globalIndex - row * source.demColumns
    const x = column - source.columnStart
    // Solver y points north; DEM rows point south.
    const y = height - 1 - (row - source.rowStart)
    const dense = y * width + x
    denseByGlobal.set(globalIndex, dense)
    mask[dense] = ACTIVE
    elevationM[dense] = source.elevationM[position]
    manningN[dense] = Number.isFinite(manning[position]) ? manning[position] : 0.05
    initialState[dense * 4 + 3] = 1
  }
  markExterior(mask, width, height)

  const cellAreaM2 = cellSizeM * cellSizeM
  let inletDischargeM3s = 0
  for (const inlet of scenario.inlets.filter((item) => item.enabled)) {
    const denseCells = inlet.cellIds.map((id) => resolveInletCell(
      id, source, denseByGlobal,
    ))
    if (denseCells.length === 0) continue
    inletDischargeM3s += inlet.dischargeM3s
    const depthRate = inlet.dischargeM3s / (denseCells.length * cellAreaM2)
    const [velocityU, velocityV] = inletVelocity(inlet)
    for (const dense of denseCells) {
      inletDepthRateMps[dense] += depthRate
      inletXMomentumRate[dense] += depthRate * velocityU
      inletYMomentumRate[dense] += depthRate * velocityV
      if (inlet.initialWaterLevelM != null) {
        const depth = Math.max(inlet.initialWaterLevelM - elevationM[dense], 0)
        initialState[dense * 4] = Math.max(initialState[dense * 4], depth)
      }
    }
  }

  let initialWaterVolumeM3 = 0
  for (let cell = 0; cell < length; cell += 1) {
    if (mask[cell] === ACTIVE) initialWaterVolumeM3 += initialState[cell * 4] * cellAreaM2
  }
  return {
    width,
    height,
    cellSizeM,
    corners: source.corners,
    mask,
    elevationM,
    manningN,
    inletDepthRateMps,
    inletXMomentumRate,
    inletYMomentumRate,
    initialState,
    activeCellCount: source.cellCount,
    activeAreaM2: source.cellCount * cellAreaM2,
    initialWaterVolumeM3,
    inletDischargeM3s,
  }
}

function resolveInletCell(
  id: string,
  source: SimulationGrid,
  denseByGlobal: Map<number, number>,
): number {
  const parsed = parseCellId(id)
  if (!parsed) throw new Error(`快速预览入口网格编号无效：${id}`)
  const global = parsed[0] * source.demColumns + parsed[1]
  const dense = denseByGlobal.get(global)
  if (dense == null) throw new Error(`快速预览入口网格不在计算域内：${id}`)
  return dense
}

function inletVelocity(inlet: Inlet): [number, number] {
  if (inlet.velocityMode === 'components') {
    return [inlet.velocityUMps ?? 0, inlet.velocityVMps ?? 0]
  }
  if (inlet.velocityMode === 'bearing') {
    const radians = (inlet.bearingDegrees ?? 0) * Math.PI / 180
    const speed = inlet.speedMps ?? 0
    return [speed * Math.sin(radians), speed * Math.cos(radians)]
  }
  return [0, 0]
}

/** Flood-fill inactive cells connected to the rectangular exterior. */
function markExterior(mask: Float32Array, width: number, height: number) {
  const queue: number[] = []
  const add = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const index = y * width + x
    if (mask[index] !== SOLID_HOLE) return
    mask[index] = EXTERIOR
    queue.push(index)
  }
  for (let x = 0; x < width; x += 1) {
    add(x, 0)
    add(x, height - 1)
  }
  for (let y = 1; y < height - 1; y += 1) {
    add(0, y)
    add(width - 1, y)
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor]
    const x = index % width
    const y = Math.floor(index / width)
    add(x - 1, y)
    add(x + 1, y)
    add(x, y - 1)
    add(x, y + 1)
  }
}
