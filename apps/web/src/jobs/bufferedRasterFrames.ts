import type { Map, RasterTileSource } from 'maplibre-gl'
import type { ResultQuantity, SimulationFrame } from '../api/types'

interface BufferedFrameRequest {
  url: string
  frameIndex: number
  onDisplayed?: (frameIndex: number) => void
  opacity?: number
}

export interface BufferState {
  active: 0 | 1
  urls: [string | null, string | null]
  loading: (BufferedFrameRequest & { buffer: 0 | 1 }) | null
  pending: BufferedFrameRequest | null
  waitingForStyle: boolean
}

export function createBufferState(): BufferState {
  return {
    active: 0,
    urls: [null, null],
    loading: null,
    pending: null,
    waitingForStyle: false,
  }
}

export function installBufferedFrame(
  map: Map,
  state: BufferState,
  frame: SimulationFrame,
  quantity: ResultQuantity,
  onDisplayed?: (frameIndex: number) => void,
  opacity = 0.84,
) {
  const tileUrl = frame.tilejson[quantity].replace(
    `/tilejson/${quantity}`,
    `/tiles/${quantity}/{z}/{x}/{y}.png`,
  )
  const request = { url: tileUrl, frameIndex: frame.frameIndex, onDisplayed, opacity }
  if (state.urls[state.active] === tileUrl) {
    state.pending = null
    onDisplayed?.(frame.frameIndex)
    return
  }
  if (state.loading) {
    state.pending = state.loading.url === tileUrl ? null : request
    return
  }

  state.pending = request
  if (map.getSource('base')) {
    startPendingFrame(map, state)
  } else if (!state.waitingForStyle) {
    state.waitingForStyle = true
    map.once('styledata', () => {
      state.waitingForStyle = false
      startPendingFrame(map, state)
    })
  }
}

function startPendingFrame(map: Map, state: BufferState) {
  const request = state.pending
  if (
    !request
    || state.loading
    || state.urls[state.active] === request.url
  ) return
  state.pending = null
  const tileUrl = request.url

  const next = state.active === 0 ? 1 : 0
  const sourceId = `result-${next}`
  const layerId = `result-layer-${next}`
  const source = map.getSource(sourceId) as RasterTileSource | undefined
  if (source) source.setTiles([tileUrl])
  else {
    map.addSource(sourceId, {
      type: 'raster',
      tiles: [tileUrl],
      tileSize: 256,
    })
    map.addLayer({
      id: layerId,
      type: 'raster',
      source: sourceId,
      paint: {
        'raster-opacity': 0,
        'raster-opacity-transition': { duration: 220, delay: 0 },
      },
    })
  }
  state.urls[next] = tileUrl
  state.loading = { buffer: next, ...request }

  const reveal = () => {
    if (!map.isSourceLoaded(sourceId)) return
    map.off('sourcedata', reveal)
    map.setPaintProperty(layerId, 'raster-opacity', request.opacity ?? 0.84)
    const previousLayer = `result-layer-${state.active}`
    if (map.getLayer(previousLayer)) {
      map.setPaintProperty(previousLayer, 'raster-opacity', 0)
    }
    state.active = next
    state.loading = null
    request.onDisplayed?.(request.frameIndex)
    startPendingFrame(map, state)
  }
  map.on('sourcedata', reveal)
  reveal()
}
