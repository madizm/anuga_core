import { describe, expect, it, vi } from 'vitest'
import { initializeWebGlResources } from './webgl2PreviewSolver'

describe('initializeWebGlResources', () => {
  it('loses the context when late initialization fails', () => {
    const loseContext = vi.fn()
    const gl = {
      getExtension: vi.fn(() => ({ loseContext })),
    } as unknown as WebGL2RenderingContext

    expect(() => initializeWebGlResources(gl, () => {
      throw new Error('state upload failed')
    })).toThrow('快速预览初始化失败：state upload failed')
    expect(loseContext).toHaveBeenCalledOnce()
  })
})
