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

function productionContext(failAt: 'program' | 'vertexArray' | 'framebuffer' | 'texture') {
  const handles: Record<string, object[]> = {
    shaders: [], programs: [], vertexArrays: [], framebuffers: [], textures: [],
  }
  const make = (kind: keyof typeof handles) => {
    const handle = { kind, index: handles[kind].length }
    handles[kind].push(handle)
    return handle
  }
  class FakeWebGL2RenderingContext {}
  const gl = Object.assign(new FakeWebGL2RenderingContext(), {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    TEXTURE_2D: 5, TEXTURE_MIN_FILTER: 6, TEXTURE_MAG_FILTER: 7,
    TEXTURE_WRAP_S: 8, TEXTURE_WRAP_T: 9, NEAREST: 10, CLAMP_TO_EDGE: 11,
    RGBA32F: 12, RGBA: 13, FLOAT: 14, R32F: 15, RED: 16, NO_ERROR: 0,
    createShader: vi.fn(() => make('shaders')),
    shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), getShaderInfoLog: vi.fn(),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => failAt === 'program' ? null : make('programs')),
    attachShader: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true), getProgramInfoLog: vi.fn(),
    deleteProgram: vi.fn(),
    createVertexArray: vi.fn(() => failAt === 'vertexArray' ? null : make('vertexArrays')),
    deleteVertexArray: vi.fn(),
    createFramebuffer: vi.fn(() => failAt === 'framebuffer' ? null : make('framebuffers')),
    deleteFramebuffer: vi.fn(),
    createTexture: vi.fn(() => failAt === 'texture' ? null : make('textures')),
    deleteTexture: vi.fn(),
    bindTexture: vi.fn(), texParameteri: vi.fn(), texImage2D: vi.fn(),
    getExtension: vi.fn((name: string) => name === 'EXT_color_buffer_float' ? {} : null),
    getError: vi.fn(() => 0),
  })
  return { gl: gl as unknown as WebGL2RenderingContext, handles, constructor: FakeWebGL2RenderingContext }
}

function minimalGrid(): DensePreviewGrid {
  return {
    width: 1, height: 1, cellSizeM: 1,
    corners: [[0, 1], [1, 1], [0, 0], [1, 0]],
    mask: new Float32Array([1]), elevationM: new Float32Array([0]),
    manningN: new Float32Array([0.03]), inletDepthRateMps: new Float32Array(1),
    inletXMomentumRate: new Float32Array(1), inletYMomentumRate: new Float32Array(1),
    initialState: new Float32Array(4), activeCellCount: 1, activeAreaM2: 1,
    initialWaterVolumeM3: 0, inletDischargeM3s: 0,
  }
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

  it.each(['program', 'vertexArray', 'framebuffer', 'texture'] as const)(
    'cleans production allocations after a %s creation failure',
    (failAt) => {
      const fake = productionContext(failAt)
      vi.stubGlobal('WebGL2RenderingContext', fake.constructor)
      const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockImplementation(() => fake.gl)

      expect(() => new WebGL2PreviewSolver(minimalGrid())).toThrow('快速预览初始化失败')
      for (const shader of fake.handles.shaders) {
        expect(fake.gl.deleteShader).toHaveBeenCalledWith(shader)
      }
      for (const program of fake.handles.programs) {
        expect(fake.gl.deleteProgram).toHaveBeenCalledWith(program)
      }
      for (const vertexArray of fake.handles.vertexArrays) {
        expect(fake.gl.deleteVertexArray).toHaveBeenCalledWith(vertexArray)
      }
      for (const framebuffer of fake.handles.framebuffers) {
        expect(fake.gl.deleteFramebuffer).toHaveBeenCalledWith(framebuffer)
      }
      for (const texture of fake.handles.textures) {
        expect(fake.gl.deleteTexture).toHaveBeenCalledWith(texture)
      }
      getContext.mockRestore()
      vi.unstubAllGlobals()
    },
  )
})
