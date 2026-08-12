import type { PreviewCapabilities } from './types'

export function detectPreviewCapabilities(
  createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
): PreviewCapabilities {
  if (typeof document === 'undefined') return unsupported('当前环境没有浏览器画布')
  const canvas = createCanvas()
  const context = canvas.getContext('webgl2', {
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
  })
  if (typeof WebGL2RenderingContext === 'undefined' || !(context instanceof WebGL2RenderingContext)) {
    return unsupported('浏览器或显卡未提供 WebGL2')
  }
  const maxTextureSize = Number(context.getParameter(context.MAX_TEXTURE_SIZE)) || 0
  const extension = context.getExtension('EXT_color_buffer_float')
  if (!extension) {
    return {
      supported: false,
      webgl2: true,
      floatFramebuffer: false,
      maxTextureSize,
      reason: '显卡不支持浮点计算纹理',
      staticSupported: false,
      staticReason: '显卡不支持浮点计算纹理',
    }
  }
  const texture = context.createTexture()
  const framebuffer = context.createFramebuffer()
  if (!texture || !framebuffer) {
    return {
      supported: false,
      webgl2: true,
      floatFramebuffer: false,
      maxTextureSize,
      reason: '无法创建预览计算缓冲区',
      staticSupported: false,
      staticReason: '无法创建预览计算缓冲区',
    }
  }
  context.bindTexture(context.TEXTURE_2D, texture)
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST)
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST)
  context.texImage2D(
    context.TEXTURE_2D, 0, context.RGBA32F, 2, 2, 0,
    context.RGBA, context.FLOAT, null,
  )
  context.bindFramebuffer(context.FRAMEBUFFER, framebuffer)
  context.framebufferTexture2D(
    context.FRAMEBUFFER, context.COLOR_ATTACHMENT0,
    context.TEXTURE_2D, texture, 0,
  )
  const complete = context.checkFramebufferStatus(context.FRAMEBUFFER)
    === context.FRAMEBUFFER_COMPLETE
  context.deleteFramebuffer(framebuffer)
  context.deleteTexture(texture)
  const staticProbe = complete
    ? probeStaticPreviewAllocation(context)
    : { supported: false, reason: '浮点计算缓冲区不完整' }
  return {
    supported: complete,
    webgl2: true,
    floatFramebuffer: complete,
    maxTextureSize,
    staticSupported: staticProbe.supported,
    staticReason: staticProbe.reason,
    reason: complete ? null : '浮点计算缓冲区不完整',
  }
}

function probeStaticPreviewAllocation(context: WebGL2RenderingContext) {
  const textures: WebGLTexture[] = []
  const framebuffer = context.createFramebuffer()
  try {
    if (!framebuffer) throw new Error('无法创建静态预览帧缓冲')
    for (let index = 0; index < 2; index += 1) {
      const texture = context.createTexture()
      if (!texture) throw new Error('无法创建静态预览状态纹理')
      textures.push(texture)
      context.bindTexture(context.TEXTURE_2D, texture)
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST)
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST)
      context.texImage2D(
        context.TEXTURE_2D, 0, context.RGBA32F, 1_024, 1_024, 0,
        context.RGBA, context.FLOAT, null,
      )
    }
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer)
    context.framebufferTexture2D(
      context.FRAMEBUFFER, context.COLOR_ATTACHMENT0,
      context.TEXTURE_2D, textures[0], 0,
    )
    const complete = context.checkFramebufferStatus(context.FRAMEBUFFER)
      === context.FRAMEBUFFER_COMPLETE
    const noError = context.getError() === context.NO_ERROR
    return complete && noError
      ? { supported: true, reason: null }
      : { supported: false, reason: '显卡无法分配 1M Cell 静态预览状态纹理' }
  } catch (error) {
    return { supported: false, reason: (error as Error).message }
  } finally {
    if (framebuffer) context.deleteFramebuffer(framebuffer)
    for (const texture of textures) context.deleteTexture(texture)
    context.bindFramebuffer(context.FRAMEBUFFER, null)
    context.bindTexture(context.TEXTURE_2D, null)
  }
}

function unsupported(reason: string): PreviewCapabilities {
  return {
    supported: false,
    webgl2: false,
    floatFramebuffer: false,
    maxTextureSize: 0,
    staticSupported: false,
    staticReason: reason,
    reason,
  }
}
