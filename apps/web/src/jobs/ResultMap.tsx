import { useEffect, useRef } from 'react'
import maplibregl, { type Map, type MapOptions } from 'maplibre-gl'
import type { ResultQuantity, SimulationFrame } from '../api/types'
import { BASE_MAP_ATTRIBUTION, BASE_MAP_TILE_URL } from '../map/baseMap'
import {
  createBufferState,
  installBufferedFrame,
  type BufferState,
} from './bufferedRasterFrames'

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
  onPoint: (longitude: number, latitude: number) => void
  onFrameDisplayed?: (frameIndex: number) => void
}

export function ResultMap({ frame, bounds, quantity, triple, onPoint, onFrameDisplayed }: ResultMapProps) {
  const containers = useRef<(HTMLDivElement | null)[]>([])
  const onPointRef = useRef(onPoint)
  onPointRef.current = onPoint
  const onFrameDisplayedRef = useRef(onFrameDisplayed)
  onFrameDisplayedRef.current = onFrameDisplayed
  const maps = useRef<Map[]>([])
  const buffers = useRef<BufferState[]>([])
  const displayedFrames = useRef<number[]>([])
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
    displayedFrames.current = quantities.map(() => -1)
    return () => {
      for (const map of maps.current) map.remove()
      maps.current = []
      buffers.current = []
      displayedFrames.current = []
    }
  // Recreate when the layout changes or asynchronously loaded bounds arrive.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triple, bounds])

  useEffect(() => {
    maps.current.forEach((map, index) => {
      const displayedQuantity = triple ? QUANTITIES[index] : quantity
      installBufferedFrame(map, buffers.current[index], frame, displayedQuantity, (frameIndex) => {
        displayedFrames.current[index] = frameIndex
        if (displayedFrames.current.every((value) => value === frameIndex)) {
          onFrameDisplayedRef.current?.(frameIndex)
        }
      })
    })
  }, [frame, quantity, triple])

  return (
    <div className={triple ? 'result-maps triple' : 'result-maps'}>
      {quantities.map((displayedQuantity, index) => (
        <div className="result-map-cell" key={triple ? displayedQuantity : 'single'}>
          <div ref={(element) => { containers.current[index] = element }} className="result-map-canvas" />
          <span className={`result-map-label ${displayedQuantity}`}>{LABELS[displayedQuantity]}</span>
          <div className={`result-legend ${displayedQuantity}`}>
            <i />
            <div>{legendTicks(displayedQuantity).map((tick) => <span key={tick}>{tick}</span>)}</div>
          </div>
        </div>
      ))}
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
