import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

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

function mockFlowResponse(buffer: ArrayBuffer) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(buffer, {
    status: 200,
    headers: { 'content-type': 'application/vnd.bayuquan.flow-field' },
  }))
}

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

  it('rejects truncated v2 payloads', async () => {
    const buffer = flowPayload(2, [Number.NaN, Number.NaN, Number.NaN, 1, 3, 4])
    mockFlowResponse(buffer.slice(0, 44 + 4 * 4))

    await expect(api.flowField('job-a', 7)).rejects.toThrow('流向场数据不完整')
  })

  it('rejects unknown versions', async () => {
    mockFlowResponse(flowPayload(3 as 1, [1, 2]))

    await expect(api.flowField('job-a', 7)).rejects.toThrow('流向场格式不受支持')
  })
})
