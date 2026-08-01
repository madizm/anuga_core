import type { Map, Point } from 'maplibre-gl'
import type { FlowField } from '../api/types'

interface Particle {
  longitude: number
  latitude: number
  ageSeconds: number
}

const MIN_SPEED_MPS = 0.03
const VISUAL_SECONDS_PER_SECOND = 180
const TRAIL_TAU_SECONDS = 0.45
const PARTICLE_MIN_AGE_SECONDS = 1.4
const PARTICLE_AGE_SPREAD_SECONDS = 3.2
// Particle count tracks the wet area's on-screen size, not its cell count:
// a fixed count saturates small basins with overlapping trails (the whole
// water body turns white), while the same count looks sparse when zoomed in.
const PARTICLE_DENSITY_PX = 700
const PARTICLE_MIN_COUNT = 80
const PARTICLE_MAX_COUNT = 700

/**
 * Advects particles through the frame velocity field and lets their paths
 * accumulate into fading trails, so the overlay reads as continuous flowing
 * water instead of isolated dots. Trails and surviving particles carry over
 * when the simulation advances to the next frame: old streamlines fade out
 * while the live particles are taken over by the new field.
 */
export class FlowParticleLayer {
  private readonly canvas = document.createElement('canvas')
  private readonly context: CanvasRenderingContext2D
  private particles: Particle[] = []
  private field: FlowField | null = null
  private wetCells: number[] = []
  private animationFrame: number | null = null
  private lastFrameTime = 0
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

  constructor(private readonly map: Map) {
    const context = this.canvas.getContext('2d')
    if (!context) throw new Error('flow canvas is unavailable')
    this.context = context
    this.canvas.className = 'flow-particle-canvas'
    this.canvas.setAttribute('aria-hidden', 'true')
    this.map.getContainer().appendChild(this.canvas)
    this.map.on('resize', this.resize)
    this.map.on('move', this.handleMove)
    this.reducedMotion.addEventListener('change', this.motionPreferenceChanged)
    this.resize()
  }

  setField(field: FlowField | null, frameIndex: number | null) {
    this.stop()
    const keepTrails = field != null
      && this.field != null
      && field.width === this.field.width
      && field.height === this.field.height
      && this.particles.length > 0
      && this.canvas.dataset.flowMode === 'animated'
    this.field = field
    this.wetCells = field ? this.findWetCells(field) : []
    if (frameIndex == null) this.canvas.removeAttribute('data-flow-frame')
    else this.canvas.dataset.flowFrame = String(frameIndex)
    if (!field || this.wetCells.length === 0) {
      this.particles = []
      this.canvas.removeAttribute('data-flow-mode')
      this.clearCanvas()
      return
    }
    if (this.reducedMotion.matches) {
      this.particles = []
      this.canvas.dataset.flowMode = 'static'
      this.drawStaticArrows()
      return
    }
    this.canvas.dataset.flowMode = 'animated'
    const count = this.desiredCount()
    if (keepTrails) {
      // Keep the surviving particles and the fading trails: the new field
      // takes them over from their current positions, which preserves the
      // impression of continuous water while the simulation advances.
      this.particles = this.particles.slice(0, count)
      while (this.particles.length < count) this.particles.push(this.spawn())
    } else {
      this.clearCanvas()
      this.particles = []
      for (let index = 0; index < count; index += 1) {
        this.particles.push(this.spawn(index % this.wetCells.length))
      }
    }
    this.lastFrameTime = performance.now()
    this.animationFrame = requestAnimationFrame(this.animate)
  }

  destroy() {
    this.stop()
    this.map.off('resize', this.resize)
    this.map.off('move', this.handleMove)
    this.reducedMotion.removeEventListener('change', this.motionPreferenceChanged)
    this.canvas.remove()
  }

  private findWetCells(field: FlowField) {
    const cells: number[] = []
    for (let cell = 0; cell < field.width * field.height; cell += 1) {
      const u = field.vectors[cell * 2]
      const v = field.vectors[cell * 2 + 1]
      if (Number.isFinite(u) && Number.isFinite(v) && Math.hypot(u, v) >= MIN_SPEED_MPS) {
        cells.push(cell)
      }
    }
    return cells
  }

  private spawn(offset?: number): Particle {
    if (!this.field || this.wetCells.length === 0) return { longitude: 0, latitude: 0, ageSeconds: 0 }
    const wetIndex = offset == null
      ? Math.floor(Math.random() * this.wetCells.length)
      : offset
    const cell = this.wetCells[wetIndex % this.wetCells.length]
    const row = Math.floor(cell / this.field.width)
    const column = cell % this.field.width
    const [west, south, east, north] = this.field.bounds
    return {
      longitude: west + (column + Math.random()) / this.field.width * (east - west),
      latitude: north - (row + Math.random()) / this.field.height * (north - south),
      ageSeconds: PARTICLE_MIN_AGE_SECONDS + Math.random() * PARTICLE_AGE_SPREAD_SECONDS,
    }
  }

  private sample(longitude: number, latitude: number): [number, number] | null {
    if (!this.field) return null
    const [west, south, east, north] = this.field.bounds
    // Bilinear interpolation between cell centres: dry (NaN) neighbours are
    // excluded and the remaining weights renormalised. Nearest-neighbour
    // sampling turns smooth circulation into polygonal rings near a vortex.
    const gridX = (longitude - west) / (east - west) * this.field.width - 0.5
    const gridY = (north - latitude) / (north - south) * this.field.height - 0.5
    const column = Math.floor(gridX)
    const row = Math.floor(gridY)
    const fractionX = gridX - column
    const fractionY = gridY - row
    let u = 0
    let v = 0
    let weightSum = 0
    for (let corner = 0; corner < 4; corner += 1) {
      const neighbourColumn = column + (corner & 1)
      const neighbourRow = row + (corner >> 1)
      if (
        neighbourColumn < 0 || neighbourColumn >= this.field.width
        || neighbourRow < 0 || neighbourRow >= this.field.height
      ) continue
      const weight = (corner & 1 ? fractionX : 1 - fractionX)
        * (corner >> 1 ? fractionY : 1 - fractionY)
      if (weight === 0) continue
      const offset = (neighbourRow * this.field.width + neighbourColumn) * 2
      const neighbourU = this.field.vectors[offset]
      const neighbourV = this.field.vectors[offset + 1]
      if (!Number.isFinite(neighbourU) || !Number.isFinite(neighbourV)) continue
      u += neighbourU * weight
      v += neighbourV * weight
      weightSum += weight
    }
    if (weightSum === 0) return null
    u /= weightSum
    v /= weightSum
    if (Math.hypot(u, v) < MIN_SPEED_MPS) return null
    return [u, v]
  }

  private readonly animate = (time: number) => {
    const elapsed = Math.min((time - this.lastFrameTime) / 1000, 0.08)
    this.lastFrameTime = time
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)

    // Fade the accumulated trails instead of clearing: each particle keeps
    // drawing over its own recent path, which builds continuous streamlines.
    this.context.globalCompositeOperation = 'destination-out'
    this.context.fillStyle = `rgba(0, 0, 0, ${1 - Math.exp(-elapsed / TRAIL_TAU_SECONDS)})`
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height)
    this.context.globalCompositeOperation = 'lighter'
    this.context.lineCap = 'round'

    for (let index = 0; index < this.particles.length; index += 1) {
      let particle = this.particles[index]
      const velocity = this.sample(particle.longitude, particle.latitude)
      particle.ageSeconds -= elapsed
      if (!velocity || particle.ageSeconds <= 0) {
        particle = this.spawn()
        this.particles[index] = particle
        continue
      }
      const before = this.map.project([particle.longitude, particle.latitude])
      const seconds = elapsed * VISUAL_SECONDS_PER_SECOND
      const latitudeRadians = particle.latitude * Math.PI / 180
      particle.longitude += velocity[0] * seconds / Math.max(111_320 * Math.cos(latitudeRadians), 1)
      particle.latitude += velocity[1] * seconds / 110_540
      const after = this.map.project([particle.longitude, particle.latitude])
      if (!pointIsVisible(before, this.canvas) && !pointIsVisible(after, this.canvas)) continue
      const speed = Math.hypot(...velocity)
      this.context.strokeStyle = `rgba(83, 231, 255, ${Math.min(0.42, 0.05 + speed * 0.26)})`
      this.context.lineWidth = Math.min(2.2, 0.8 + speed * 0.25) * pixelRatio
      this.context.beginPath()
      this.context.moveTo(before.x * pixelRatio, before.y * pixelRatio)
      this.context.lineTo(after.x * pixelRatio, after.y * pixelRatio)
      this.context.stroke()
      // A brighter head makes the flow direction readable while the fading
      // trail stretches behind it like a comet tail.
      this.context.fillStyle = `rgba(190, 249, 255, ${Math.min(0.6, 0.12 + speed * 0.3)})`
      this.context.beginPath()
      this.context.arc(
        after.x * pixelRatio,
        after.y * pixelRatio,
        Math.min(1.7, 0.7 + speed * 0.2) * pixelRatio,
        0,
        Math.PI * 2,
      )
      this.context.fill()
    }
    this.context.globalCompositeOperation = 'source-over'
    this.animationFrame = requestAnimationFrame(this.animate)
  }

  private drawStaticArrows() {
    if (!this.field) return
    this.clearCanvas()
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    const stride = Math.max(1, Math.ceil(Math.sqrt(this.wetCells.length / 180)))
    this.context.strokeStyle = 'rgba(83, 231, 255, .78)'
    this.context.fillStyle = 'rgba(83, 231, 255, .9)'
    this.context.lineWidth = pixelRatio
    for (let index = 0; index < this.wetCells.length; index += stride) {
      const cell = this.wetCells[index]
      const row = Math.floor(cell / this.field.width)
      const column = cell % this.field.width
      const [west, south, east, north] = this.field.bounds
      const longitude = west + (column + 0.5) / this.field.width * (east - west)
      const latitude = north - (row + 0.5) / this.field.height * (north - south)
      const velocity = this.sample(longitude, latitude)
      if (!velocity) continue
      const origin = this.map.project([longitude, latitude])
      const latitudeRadians = latitude * Math.PI / 180
      const projectedEnd = this.map.project([
        longitude + velocity[0] * VISUAL_SECONDS_PER_SECOND
          / Math.max(111_320 * Math.cos(latitudeRadians), 1),
        latitude + velocity[1] * VISUAL_SECONDS_PER_SECOND / 110_540,
      ])
      const deltaX = projectedEnd.x - origin.x
      const deltaY = projectedEnd.y - origin.y
      const projectedLength = Math.hypot(deltaX, deltaY)
      if (projectedLength < 0.01) continue
      const length = 8 + Math.min(10, Math.hypot(...velocity) * 2)
      const endX = origin.x + deltaX / projectedLength * length
      const endY = origin.y + deltaY / projectedLength * length
      this.context.beginPath()
      this.context.moveTo(origin.x * pixelRatio, origin.y * pixelRatio)
      this.context.lineTo(endX * pixelRatio, endY * pixelRatio)
      this.context.stroke()
      this.context.beginPath()
      this.context.arc(endX * pixelRatio, endY * pixelRatio, 1.5 * pixelRatio, 0, Math.PI * 2)
      this.context.fill()
    }
  }

  private clearCanvas() {
    this.context.globalCompositeOperation = 'source-over'
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  private readonly resize = () => {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    const container = this.map.getContainer()
    this.canvas.width = Math.max(1, Math.round(container.clientWidth * pixelRatio))
    this.canvas.height = Math.max(1, Math.round(container.clientHeight * pixelRatio))
    this.canvas.style.width = `${container.clientWidth}px`
    this.canvas.style.height = `${container.clientHeight}px`
    if (this.reducedMotion.matches) this.drawStaticArrows()
  }

  private desiredCount() {
    if (!this.field || this.wetCells.length === 0) return 0
    const [west, south, east, north] = this.field.bounds
    const topLeft = this.map.project([west, north])
    const bottomRight = this.map.project([east, south])
    const cellAreaPx = Math.abs(
      (bottomRight.x - topLeft.x) * (bottomRight.y - topLeft.y),
    ) / (this.field.width * this.field.height)
    if (!Number.isFinite(cellAreaPx) || cellAreaPx <= 0) {
      return Math.min(900, Math.max(160, this.wetCells.length * 2))
    }
    const wetPixels = this.wetCells.length * cellAreaPx
    return Math.round(Math.min(
      PARTICLE_MAX_COUNT,
      Math.max(PARTICLE_MIN_COUNT, wetPixels / PARTICLE_DENSITY_PX),
    ))
  }

  private readonly handleMove = () => {
    if (this.canvas.dataset.flowMode === 'static') {
      this.drawStaticArrows()
      return
    }
    // Trail pixels are anchored to the previous view; keeping them while
    // the map pans or zooms would smear stale streamlines across the map.
    this.clearCanvas()
    // Zooming changes the wet area's screen size; trim or top up the
    // particle population so trail density stays roughly constant.
    const target = this.desiredCount()
    if (target === 0 || this.particles.length === 0) return
    if (this.particles.length > target) {
      this.particles.length = target
    } else {
      while (this.particles.length < target) this.particles.push(this.spawn())
    }
  }

  private readonly motionPreferenceChanged = () => {
    const frameIndex = this.canvas.dataset.flowFrame
    this.setField(this.field, frameIndex == null ? null : Number(frameIndex))
  }

  private stop() {
    if (this.animationFrame != null) cancelAnimationFrame(this.animationFrame)
    this.animationFrame = null
  }
}

function pointIsVisible(point: Point, canvas: HTMLCanvasElement) {
  const width = Number.parseFloat(canvas.style.width) || canvas.width
  const height = Number.parseFloat(canvas.style.height) || canvas.height
  return point.x >= -8 && point.y >= -8 && point.x <= width + 8 && point.y <= height + 8
}
