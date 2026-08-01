import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, decodeFloat16 } from './client'

function flowPayload(version: 1 | 2, cells: number[]) {
  const buffer = new ArrayBuffer(44 + cells.length * 4)
  const view = new DataView(buffer)
  for (const [index, byte] of [...'BQFV'].entries()) {
    view.setUint8(index, byte.charCodeAt(0))
  }
  view.setUint16(4, version, true)
  view.setUint16(6, 2, true)
  view.setUint16(8, 1, true)
  view.setFloat64(12, 122.1, true)
  view.setFloat64(20, 40.1, true)
  view.setFloat64(28, 122.2, true)
  view.setFloat64(36, 40.2, true)
  new Float32Array(buffer, 44).set(cells)
  return buffer
}

function flowPayloadV3(cells: number[]) {
  const buffer = new ArrayBuffer(44 + cells.length * 2)
  const view = new DataView(buffer)
  for (const [index, byte] of [...'BQFV'].entries()) {
    view.setUint8(index, byte.charCodeAt(0))
  }
  view.setUint16(4, 3, true)
  view.setUint16(6, 2, true)
  view.setUint16(8, 1, true)
  view.setFloat64(12, 122.1, true)
  view.setFloat64(20, 40.1, true)
  view.setFloat64(28, 122.2, true)
  view.setFloat64(36, 40.2, true)
  new Uint16Array(buffer, 44).set(cells)
  return buffer
}

function mockFlowResponse(buffer: ArrayBuffer) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(buffer, {
    status: 200,
    headers: { 'content-type': 'application/vnd.bayuquan.flow-field' },
  }))
}

// Reference fp16 bit patterns: 3, 4, 1, 6, -1, 0.
const FP16 = { three: 0x4200, four: 0x4400, one: 0x3c00, six: 0x4600, minusOne: 0xbc00, zero: 0x0000 }

describe('decodeFloat16', () => {
  it('decodes normal, subnormal, and special values', () => {
    expect(decodeFloat16(FP16.three)).toBe(3)
    expect(decodeFloat16(FP16.minusOne)).toBe(-1)
    expect(decodeFloat16(FP16.zero)).toBe(0)
    expect(decodeFloat16(0x0001)).toBeCloseTo(2 ** -24, 10)
    expect(decodeFloat16(0x7c00)).toBe(Infinity)
    expect(decodeFloat16(0x7e00)).toBeNaN()
  })
})

describe('api.flowField', () => {
  afterEach(() => vi.restoreAllMocks())

  it('decodes the v1 interleaved velocity field without depths', async () => {
    mockFlowResponse(flowPayload(1, [Number.NaN, Number.NaN, 3, 4]))

    const field = await api.flowField('job-a', 7)

    expect(field.width).toBe(2)
    expect(field.height).toBe(1)
    expect(field.bounds).toEqual([122.1, 40.1, 122.2, 40.2])
    expect([...field.vectors.slice(2)]).toEqual([3, 4])
    expect(Number.isNaN(field.vectors[0])).toBe(true)
    expect(field.depths).toBeNull()
  })

  it('splits the v2 (depth, u, v) planes apart', async () => {
    mockFlowResponse(flowPayload(2, [
      Number.NaN, Number.NaN, Number.NaN,
      1, 3, 4,
    ]))

    const field = await api.flowField('job-a', 7)

    expect(field.width).toBe(2)
    expect(field.height).toBe(1)
    expect([...field.vectors.slice(2)]).toEqual([3, 4])
    expect(Number.isNaN(field.vectors[0])).toBe(true)
    expect(field.depths).not.toBeNull()
    expect([...field.depths!.slice(1)]).toEqual([1])
    expect(Number.isNaN(field.depths![0])).toBe(true)
  })

  it('decodes v3 fp16 texels and unpacks velocities for CPU consumers', async () => {
    mockFlowResponse(flowPayloadV3([
      FP16.zero, FP16.zero, FP16.minusOne, FP16.zero,
      FP16.three, FP16.four, FP16.one, FP16.six,
    ]))

    const field = await api.flowField('job-a', 7)

    expect(field.width).toBe(2)
    expect(field.height).toBe(1)
    expect(field.texels).not.toBeNull()
    expect(field.texels!.length).toBe(8)
    expect(field.texels![2]).toBe(FP16.minusOne)
    expect(field.depths).toBeNull()
    expect([...field.vectors]).toEqual([0, 0, 3, 4])
  })

  it('rejects truncated v2 payloads', async () => {
    const buffer = flowPayload(2, [Number.NaN, Number.NaN, Number.NaN, 1, 3, 4])
    mockFlowResponse(buffer.slice(0, 44 + 4 * 4))

    await expect(api.flowField('job-a', 7)).rejects.toThrow('流向场数据不完整')
  })

  it('rejects truncated v3 payloads', async () => {
    const buffer = flowPayloadV3([0, 0, 0xbc00, 0, 0x4200, 0x4400, 0x3c00, 0x4600])
    mockFlowResponse(buffer.slice(0, 44 + 4 * 2))

    await expect(api.flowField('job-a', 7)).rejects.toThrow('流向场数据不完整')
  })

  it('rejects unknown versions', async () => {
    mockFlowResponse(flowPayload(4 as 1, [1, 2]))

    await expect(api.flowField('job-a', 7)).rejects.toThrow('流向场格式不受支持')
  })
})
