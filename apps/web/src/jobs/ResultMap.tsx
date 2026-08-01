import { useEffect, useRef, useState } from 'react'
import maplibregl, { type Map, type MapOptions } from 'maplibre-gl'
import type { FlowField, ResultQuantity, SimulationFrame } from '../api/types'
import { BASE_MAP_ATTRIBUTION, BASE_MAP_TILE_URL } from '../map/baseMap'
import {
  createBufferState,
  installBufferedFrame,
  type BufferState,
} from './bufferedRasterFrames'
import { FlowParticleLayer } from './FlowParticleLayer'
import { WaterRippleLayer } from './WaterRippleLayer'
import { installWaterRippleTuningPanel } from './waterRippleParams'
import { TerrainControl } from '../map/TerrainControl'
import {
  applyTerrain,
  HILLSHADE_LAYER,
  installTerrain,
  setTerrainCamera,
  TERRAIN_SOURCE,
  terrainSourceFromEvent,
} from '../map/terrain'
import { useTerrainStore } from '../map/terrainStore'

const QUANTITIES: ResultQuantity[] = ['depth', 'stage', 'speed']
const LABELS: Record<ResultQuantity, string> = {
  depth: '水深 DEPTH',
  stage: '水位 STAGE',
  speed: '流速 SPEED',
}

interface ResultMapProps {
  frame: SimulationFrame
  bounds?: [number, number, number, number]
  quantity: ResultQuantity
  triple: boolean
  flowEnabled: boolean
  flowField?: FlowField
  flowFrameIndex?: number
  demTilejsonUrl?: string
  terrainTilejsonUrl?: string
  onPoint: (longitude: number, latitude: number) => void
  onFrameDisplayed?: (frameIndex: number) => void
}

export function ResultMap({
  frame,
  bounds,
  quantity,
  triple,
  flowEnabled,
  flowField,
  flowFrameIndex,
  demTilejsonUrl,
  terrainTilejsonUrl,
  onPoint,
  onFrameDisplayed,
}: ResultMapProps) {
  const containers = useRef<(HTMLDivElement | null)[]>([])
  const onPointRef = useRef(onPoint)
  onPointRef.current = onPoint
  const onFrameDisplayedRef = useRef(onFrameDisplayed)
  onFrameDisplayedRef.current = onFrameDisplayed
  const maps = useRef<Map[]>([])
  const buffers = useRef<BufferState[]>([])
  const flowLayers = useRef<FlowParticleLayer[]>([])
  const rippleLayers = useRef<(WaterRippleLayer | null)[]>([])
  const rippleField = useRef<FlowField | null>(null)
  const flowState = useRef<{ field: FlowField | null; frameIndex: number | null }>({
    field: null,
    frameIndex: null,
  })
  const displayedFrames = useRef<number[]>([])
  const terrainCameras = useRef<{ pitch: number; bearing: number }[]>([])
  const [terrainError, setTerrainError] = useState<string | null>(null)
  const [terrainRetry, setTerrainRetry] = useState(0)
  const [waterError, setWaterError] = useState<string | null>(null)
  const terrainEnabled = useTerrainStore((state) => state.resultEnabled)
  const terrainExaggeration = useTerrainStore((state) => state.exaggeration)
  const hillshade = useTerrainStore((state) => state.hillshade)
  const effectiveTerrain = terrainEnabled && !terrainError
  const quantities = triple ? QUANTITIES : [quantity]

  useEffect(() => {
    let synchronizing = false
    maps.current = quantities.map((_, index) => {
      const container = containers.current[index]
      if (!container) throw new Error('result map container is unavailable')
      const map = createMap(container, bounds)
      map.on('move', () => {
        if (synchronizing || maps.current.length < 2) return
        synchronizing = true
        const center = map.getCenter()
        for (const peer of maps.current) {
          if (peer !== map) peer.jumpTo({ center, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() })
        }
        synchronizing = false
      })
      map.on('click', (event) => onPointRef.current(event.lngLat.lng, event.lngLat.lat))
      return map
    })
    buffers.current = quantities.map(createBufferState)
    flowLayers.current = maps.current.map((map) => new FlowParticleLayer(map))
    // Maps may be recreated after flow was enabled (e.g. asynchronously
    // loaded bounds arrive): restore the latest field on the fresh layers.
    for (const layer of flowLayers.current) {
      layer.setField(flowState.current.field, flowState.current.frameIndex)
    }
    createRippleLayers()
    installWaterRippleTuningPanel()
    if (import.meta.env.DEV) {
      (window as unknown as { __resultMaps: Map[] }).__resultMaps = maps.current
    }
    displayedFrames.current = quantities.map(() => -1)
    return () => {
      for (const layer of flowLayers.current) layer.destroy()
      flowLayers.current = []
      for (const layer of rippleLayers.current) layer?.destroy()
      rippleLayers.current = []
      for (const map of maps.current) map.remove()
      maps.current = []
      buffers.current = []
      displayedFrames.current = []
    }
  // Recreate when the layout changes or asynchronously loaded bounds arrive.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triple, bounds])

  useEffect(() => {
    if (!terrainTilejsonUrl) return
    const cleanups = maps.current.map((map) => {
      const install = () => {
        try {
          const firstResultLayer = map.getLayer('result-layer-0')
            ? 'result-layer-0'
            : map.getLayer('result-layer-1') ? 'result-layer-1' : undefined
          installTerrain(map, terrainTilejsonUrl, firstResultLayer)
          if (demTilejsonUrl && !map.getSource('terrain-dem-fallback')) {
            map.addSource('terrain-dem-fallback', {
              type: 'raster', url: demTilejsonUrl, tileSize: 256,
            })
            map.addLayer({
              id: 'terrain-dem-fallback',
              type: 'raster',
              source: 'terrain-dem-fallback',
              layout: { visibility: 'none' },
              paint: { 'raster-opacity': 0.78, 'raster-saturation': -0.12 },
            }, HILLSHADE_LAYER)
          }
        } catch (error) {
          setTerrainError((error as Error).message || '地形初始化失败')
        }
      }
      const onError = (event: unknown) => {
        const sourceId = (event as { sourceId?: string }).sourceId
        if (terrainSourceFromEvent(event)) {
          setTerrainError('地形瓦片加载失败')
        } else if (sourceId === 'base' && map.getLayer('terrain-dem-fallback')) {
          map.setLayoutProperty('terrain-dem-fallback', 'visibility', 'visible')
        }
      }
      if (map.isStyleLoaded()) install()
      else map.once('load', install)
      map.on('error', onError)
      return () => {
        map.off('load', install)
        map.off('error', onError)
      }
    })
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [bounds, demTilejsonUrl, terrainRetry, terrainTilejsonUrl, triple])

  useEffect(() => {
    const apply = (map: Map) => {
      if (!map.getSource(TERRAIN_SOURCE)) return
      try {
        applyTerrain(map, effectiveTerrain, terrainExaggeration, hillshade)
      } catch (error) {
        setTerrainError((error as Error).message || '地形渲染失败')
      }
    }
    maps.current.forEach((map) => {
      if (map.isStyleLoaded()) apply(map)
      else map.once('load', () => apply(map))
    })
  }, [bounds, effectiveTerrain, hillshade, terrainExaggeration, terrainRetry, terrainTilejsonUrl, triple])

  useEffect(() => {
    while (terrainCameras.current.length < maps.current.length) {
      terrainCameras.current.push({ pitch: 55, bearing: -20 })
    }
    maps.current.forEach((map, index) => {
      const apply = () => setTerrainCamera(
        map, effectiveTerrain, terrainCameras.current[index],
      )
      if (map.isStyleLoaded()) apply()
      else map.once('load', apply)
    })
  }, [bounds, effectiveTerrain, terrainRetry, triple])

  useEffect(() => {
    maps.current.forEach((map, index) => {
      const displayedQuantity = triple ? QUANTITIES[index] : quantity
      if (flowEnabled) {
        // Water-primary mode: the shader renders the frame from the binary
        // field and no PNG tiles are fetched at all, which keeps live
        // playback from hammering the tile renderer. Report the frame so
        // playback stats stay live; advancing is gated on the field query.
        displayedFrames.current[index] = frame.frameIndex
        if (displayedFrames.current.every((value) => value === frame.frameIndex)) {
          onFrameDisplayedRef.current?.(frame.frameIndex)
        }
        return
      }
      installBufferedFrame(map, buffers.current[index], frame, displayedQuantity, (frameIndex) => {
        displayedFrames.current[index] = frameIndex
        if (displayedFrames.current.every((value) => value === frameIndex)) {
          onFrameDisplayedRef.current?.(frameIndex)
        }
      })
    })
  }, [frame, flowEnabled, quantity, triple])

  useEffect(() => {
    maps.current.forEach((map, index) => {
      const displayedQuantity = triple ? QUANTITIES[index] : quantity
      const activeLayer = `result-layer-${buffers.current[index]?.active ?? 0}`
      if (map.getLayer(activeLayer)) {
        map.setPaintProperty(activeLayer, 'raster-opacity', flowEnabled ? 0 : 0.84)
      }
      const ripple = rippleLayers.current[index]
      ripple?.setColorize(flowEnabled)
      ripple?.setQuantity(displayedQuantity)
    })
  }, [bounds, flowEnabled, quantity, triple])

  useEffect(() => {
    flowState.current = {
      field: flowEnabled ? flowField ?? null : null,
      frameIndex: flowEnabled && flowField ? flowFrameIndex ?? null : null,
    }
    rippleField.current = flowState.current.field
    if (!flowEnabled) setWaterError(null)
    for (const layer of flowLayers.current) {
      layer.setField(flowState.current.field, flowState.current.frameIndex)
    }
    for (const layer of rippleLayers.current) {
      layer?.setField(rippleField.current)
    }
  }, [flowEnabled, flowField, flowFrameIndex, triple])

  const retryTerrain = () => {
    for (const map of maps.current) {
      map.setTerrain(null)
      if (map.getLayer(HILLSHADE_LAYER)) map.removeLayer(HILLSHADE_LAYER)
      if (map.getSource(TERRAIN_SOURCE)) map.removeSource(TERRAIN_SOURCE)
    }
    setTerrainError(null)
    setTerrainRetry((value) => value + 1)
  }

  const createRippleLayers = () => {
    setWaterError(null)
    const layers: (WaterRippleLayer | null)[] = []
    for (const map of maps.current) {
      try {
        const layer = new WaterRippleLayer(map)
        layer.setField(rippleField.current)
        layers.push(layer)
      } catch (error) {
        layers.push(null)
        setWaterError((error as Error).message || '水波效果初始化失败')
      }
    }
    rippleLayers.current = layers
  }

  const retryWater = () => {
    for (const layer of rippleLayers.current) layer?.destroy()
    rippleLayers.current = []
    createRippleLayers()
  }

  return (
    <div className={triple ? 'result-maps triple' : 'result-maps'}>
      {quantities.map((displayedQuantity, index) => (
        <div className="result-map-cell" key={triple ? displayedQuantity : 'single'}>
          <div ref={(element) => { containers.current[index] = element }} className="result-map-canvas" />
          <span className={`result-map-label ${displayedQuantity}`}>{LABELS[displayedQuantity]}</span>
          {flowEnabled && flowField && (
            <span className="flow-field-status"><i /> DYNAMIC FLOW</span>
          )}
          <div className={`result-legend ${displayedQuantity}`}>
            <i />
            <div>{legendTicks(displayedQuantity).map((tick) => <span key={tick}>{tick}</span>)}</div>
          </div>
        </div>
      ))}
      <TerrainControl
        scope="result"
        error={terrainError}
        flowIsTwoDimensional={flowEnabled && Boolean(flowField)}
        waterError={waterError}
        onRetry={retryTerrain}
        onWaterRetry={retryWater}
      />
    </div>
  )
}

function legendTicks(quantity: ResultQuantity) {
  if (quantity === 'depth') return ['0.01', '0.3', '1', '2', '3+ m']
  if (quantity === 'stage') return ['0', '10', '20', '30 m']
  return ['0', '1', '2', '3+ m/s']
}

function createMap(
  container: HTMLDivElement,
  bounds?: [number, number, number, number],
): Map {
  const options: MapOptions = {
    container,
    center: [122.188, 40.301],
    zoom: 13.2,
    minZoom: 10,
    maxZoom: 19,
    attributionControl: false,
    style: {
      version: 8,
      sources: {
        base: {
          type: 'raster',
          tiles: [BASE_MAP_TILE_URL],
          tileSize: 256,
          attribution: BASE_MAP_ATTRIBUTION,
        },
      },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#081217' } },
        { id: 'base', type: 'raster', source: 'base' },
      ],
    },
  }
  if (bounds) {
    options.bounds = [[bounds[0], bounds[1]], [bounds[2], bounds[3]]]
    options.fitBoundsOptions = { padding: 72, maxZoom: 17 }
  }
  const map = new maplibregl.Map(options)
  map.on('error', (event) => {
    if (!event.error?.message.includes('Failed to fetch')) {
      console.error(event.error)
    }
  })
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
  return map
}
