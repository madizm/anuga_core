import type { Map } from 'maplibre-gl'
import type { ResultQuantity } from '../api/types'
import { FlowParticleLayer } from '../jobs/FlowParticleLayer'
import { TerrainDrapedWaterLayer } from '../jobs/TerrainDrapedWaterLayer'
import type { PreviewMode, PreviewSnapshot } from './types'

/** MapLibre adapter for browser-local preview frames. */
export class PreviewMapLayer {
  private readonly water: TerrainDrapedWaterLayer
  private readonly flow: FlowParticleLayer
  private snapshot: PreviewSnapshot | null = null
  private quantity: ResultQuantity = 'depth'
  private flowEnabled = true
  private mode: PreviewMode = 'animated'
  private destroyed = false

  constructor(private readonly map: Map) {
    this.water = new TerrainDrapedWaterLayer(map)
    this.flow = new FlowParticleLayer(map)
    map.getContainer().dataset.previewRenderer = 'webgl2'
  }

  setSnapshot(snapshot: PreviewSnapshot | null) {
    if (this.destroyed) return
    this.snapshot = snapshot
    this.apply()
  }

  setMode(mode: PreviewMode) {
    if (this.mode === mode) return
    this.mode = mode
    this.water.setAnimated(mode === 'animated')
    this.apply()
  }

  setQuantity(quantity: ResultQuantity) {
    this.quantity = quantity
    this.water.setQuantity(quantity)
  }

  setFlowEnabled(enabled: boolean) {
    this.flowEnabled = enabled
    this.apply()
  }

  setTerrainExaggeration(exaggeration: number) {
    this.flow.setTerrainExaggeration(exaggeration)
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.water.destroy()
    this.flow.destroy()
    const container = this.map.getContainer()
    delete container.dataset.previewRenderer
    delete container.dataset.previewTime
    delete container.dataset.previewField
  }

  private apply() {
    const field = this.snapshot?.field ?? null
    this.water.setColorize(true)
    this.water.setQuantity(this.quantity)
    this.water.setField(field)
    this.flow.setField(
      this.mode === 'animated' && this.flowEnabled ? field : null,
      this.mode === 'animated' && this.flowEnabled && this.snapshot
        ? Math.floor(this.snapshot.timeSeconds) : null,
    )
    const container = this.map.getContainer()
    if (this.snapshot) {
      container.dataset.previewTime = this.snapshot.timeSeconds.toFixed(2)
      container.dataset.previewField = this.quantity
    } else {
      delete container.dataset.previewTime
      delete container.dataset.previewField
    }
  }
}
