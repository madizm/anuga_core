// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { DensePreviewGrid } from './types'
import { initializeWebGlResources, WebGL2PreviewSolver } from './webgl2PreviewSolver'

function context(extension: object | null = null) {
  return {
    deleteTexture: vi.fn(),
    deleteProgram: vi.fn(),
    deleteFramebuffer: vi.fn(),
    deleteVertexArray: vi.fn(),
    deleteShader: vi.fn(),
    getExtension: vi.fn(() => extension),
  } as unknown as WebGL2RenderingContext
}

describe('initializeWebGlResources', () => {
  it('deletes partial resources when initialization fails without context loss support', () => {
    const gl = context()
    const texture = {} as WebGLTexture
    const program = {} as WebGLProgram
    const framebuffer = {} as WebGLFramebuffer
    const vertexArray = {} as WebGLVertexArrayObject

    expect(() => initializeWebGlResources(gl, (tracker) => {
      tracker.texture(texture)
      tracker.program(program)
      tracker.framebuffer(framebuffer)
      tracker.vertexArray(vertexArray)
      throw new Error('state upload failed')
    })).toThrow('快速预览初始化失败：state upload failed')
    expect(gl.deleteTexture).toHaveBeenCalledWith(texture)
    expect(gl.deleteProgram).toHaveBeenCalledWith(program)
    expect(gl.deleteFramebuffer).toHaveBeenCalledWith(framebuffer)
    expect(gl.deleteVertexArray).toHaveBeenCalledWith(vertexArray)
  })

  it('covers a missing float texture extension with the same cleanup path', () => {
    class FakeWebGL2RenderingContext {}
    vi.stubGlobal('WebGL2RenderingContext', FakeWebGL2RenderingContext)
    const gl = Object.assign(new FakeWebGL2RenderingContext(), context())
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(() => gl as unknown as WebGL2RenderingContext)

    expect(() => new WebGL2PreviewSolver({
      width: 1, height: 1,
    } as DensePreviewGrid)).toThrow('快速预览初始化失败：显卡不支持浮点预览纹理')
    expect(gl.getExtension).toHaveBeenCalledWith('EXT_color_buffer_float')
    getContext.mockRestore()
    vi.unstubAllGlobals()
  })
})
