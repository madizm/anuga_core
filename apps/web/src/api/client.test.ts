import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

function flowPayload() {
  const buffer = new ArrayBuffer(44 + 4 * 4)
  const view = new DataView(buffer)
  for (const [index, byte] of [...'BQFV'].entries()) {
    view.setUint8(index, byte.charCodeAt(0))
  }
  view.setUint16(4, 1, true)
  view.setUint16(6, 2, true)
  view.setUint16(8, 1, true)
  view.setFloat64(12, 122.1, true)
  view.setFloat64(20, 40.1, true)
  view.setFloat64(28, 122.2, true)
  view.setFloat64(36, 40.2, true)
  new Float32Array(buffer, 44).set([Number.NaN, Number.NaN, 3, 4])
  return buffer
}

describe('api.flowField', () => {
  afterEach(() => vi.restoreAllMocks())

  it('decodes the versioned interleaved velocity field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(flowPayload(), {
      status: 200,
      headers: { 'content-type': 'application/vnd.bayuquan.flow-field' },
    }))

    const field = await api.flowField('job-a', 7)

    expect(field.width).toBe(2)
    expect(field.height).toBe(1)
    expect(field.bounds).toEqual([122.1, 40.1, 122.2, 40.2])
    expect([...field.vectors.slice(2)]).toEqual([3, 4])
    expect(Number.isNaN(field.vectors[0])).toBe(true)
  })
})
