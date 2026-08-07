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
  return {
    supported: complete,
    webgl2: true,
    floatFramebuffer: complete,
    maxTextureSize,
    reason: complete ? null : '浮点计算缓冲区不完整',
  }
}

function unsupported(reason: string): PreviewCapabilities {
  return {
    supported: false,
    webgl2: false,
    floatFramebuffer: false,
    maxTextureSize: 0,
    reason,
  }
}
