import type { FeatureCollection } from 'geojson'
import { useEffect, useRef, useState } from 'react'
import maplibregl, { type Map, type MapMouseEvent, type PointLike } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useInletStore } from '../inlets/inletStore'
import { useLayerStore } from './mapStore'

interface ModelMapProps {
  grid?: FeatureCollection
}

const GRID_SOURCE = 'model-grid'
const GRID_FILL = 'model-grid-fill'
const GRID_LINE = 'model-grid-line'

export function ModelMap({ grid }: ModelMapProps) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const previousStates = useRef(new globalThis.Map<string, string>())
  const brushVisited = useRef(new Set<string>())
  const boxStart = useRef<MapMouseEvent['point'] | null>(null)
  const [box, setBox] = useState<React.CSSProperties | null>(null)
  const [gridReady, setGridReady] = useState(false)
  const inlets = useInletStore((state) => state.inlets)
  const activeId = useInletStore((state) => state.activeId)
  const selectionMode = useInletStore((state) => state.selectionMode)
  const selectCells = useInletStore((state) => state.selectCells)
  const baseVisible = useLayerStore((state) => state.base)
  const gridVisible = useLayerStore((state) => state.grid)

  useEffect(() => {
    if (!container.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: container.current,
      center: [122.188, 40.301],
      zoom: 13.2,
      minZoom: 10,
      maxZoom: 19,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          'base-map': {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors',
          },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#081217' } },
          {
            id: 'base-map',
            type: 'raster',
            source: 'base-map',
            paint: { 'raster-saturation': -1, 'raster-brightness-max': 0.42, 'raster-contrast': 0.28 },
          },
        ],
      },
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right')
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !grid) return
    const install = () => {
      if (map.getSource(GRID_SOURCE)) return
      map.addSource(GRID_SOURCE, { type: 'geojson', data: grid, promoteId: 'cell_id' })
      map.addLayer({
        id: GRID_FILL,
        type: 'fill',
        source: GRID_SOURCE,
        paint: {
          'fill-color': ['case', ['boolean', ['feature-state', 'selected'], false], ['feature-state', 'color'], '#13242b'],
          'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.7, 0.08],
        },
      })
      map.addLayer({
        id: GRID_LINE,
        type: 'line',
        source: GRID_SOURCE,
        minzoom: 13,
        paint: {
          'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#e7fdff', '#4b6c76'],
          'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 1.4, 0.45],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.25, 16, 0.75],
        },
      })
      setGridReady(true)
      const bounds = new maplibregl.LngLatBounds()
      for (const feature of grid.features) {
        const geometry = feature.geometry
        if (geometry.type !== 'Polygon') continue
        for (const coordinate of geometry.coordinates[0]) bounds.extend(coordinate as [number, number])
      }
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 54, duration: 900 })
    }
    if (map.getSource('base-map')) install()
    else map.once('styledata', install)
  }, [grid])

  useEffect(() => {
    const locate = (event: Event) => {
      const cellIds = new Set((event as CustomEvent<string[]>).detail)
      if (!grid || cellIds.size === 0 || !mapRef.current) return
      const bounds = new maplibregl.LngLatBounds()
      for (const feature of grid.features) {
        if (!cellIds.has(String(feature.properties?.cell_id))) continue
        if (feature.geometry.type !== 'Polygon') continue
        for (const point of feature.geometry.coordinates[0]) {
          bounds.extend(point as [number, number])
        }
      }
      if (!bounds.isEmpty()) {
        mapRef.current.fitBounds(bounds, { padding: 110, maxZoom: 17 })
      }
    }
    window.addEventListener('locate-inlet', locate)
    return () => window.removeEventListener('locate-inlet', locate)
  }, [grid])

  useEffect(() => {
    const map = mapRef.current
    if (!map?.getSource(GRID_SOURCE)) return
    const next = new globalThis.Map<string, string>()
    for (const inlet of inlets) {
      for (const cellId of inlet.cellIds) next.set(cellId, inlet.displayColor)
    }
    for (const [cellId] of previousStates.current) {
      if (!next.has(cellId)) map.setFeatureState({ source: GRID_SOURCE, id: cellId }, { selected: false })
    }
    for (const [cellId, color] of next) {
      if (previousStates.current.get(cellId) !== color) {
        map.setFeatureState({ source: GRID_SOURCE, id: cellId }, { selected: true, color })
      }
    }
    previousStates.current = next
  }, [inlets])

  useEffect(() => {
    const map = mapRef.current
    if (!map?.getLayer('base-map')) return
    map.setLayoutProperty('base-map', 'visibility', baseVisible ? 'visible' : 'none')
    if (map.getLayer(GRID_FILL)) {
      const visibility = gridVisible ? 'visible' : 'none'
      map.setLayoutProperty(GRID_FILL, 'visibility', visibility)
      map.setLayoutProperty(GRID_LINE, 'visibility', visibility)
    }
  }, [baseVisible, gridVisible, grid])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const featureAt = (point: PointLike) => {
      if (!map.getLayer(GRID_FILL)) return undefined
      return map.queryRenderedFeatures(point, { layers: [GRID_FILL] })[0]
    }
    const operation = (event: MouseEvent) => (event.altKey ? 'remove' : event.shiftKey ? 'add' : 'toggle')
    const onClick = (event: MapMouseEvent & { originalEvent: MouseEvent }) => {
      if (selectionMode !== 'click' || !activeId) return
      const feature = featureAt(event.point)
      const cellId = feature?.properties?.cell_id
      if (cellId) selectCells([cellId], operation(event.originalEvent))
    }
    const onMouseDown = (event: MapMouseEvent & { originalEvent: MouseEvent }) => {
      if (!activeId) return
      if (selectionMode === 'brush') {
        brushVisited.current.clear()
        const feature = featureAt(event.point)
        const cellId = feature?.properties?.cell_id
        if (cellId) {
          brushVisited.current.add(cellId)
          selectCells([cellId], event.originalEvent.altKey ? 'remove' : 'add')
        }
      }
      if (selectionMode === 'box') {
        boxStart.current = event.point
        map.dragPan.disable()
        setBox({ left: event.point.x, top: event.point.y, width: 0, height: 0 })
      }
    }
    const onMouseMove = (event: MapMouseEvent & { originalEvent: MouseEvent }) => {
      if (selectionMode === 'brush' && event.originalEvent.buttons === 1) {
        const feature = featureAt(event.point)
        const cellId = feature?.properties?.cell_id
        if (cellId && !brushVisited.current.has(cellId)) {
          brushVisited.current.add(cellId)
          selectCells([cellId], event.originalEvent.altKey ? 'remove' : 'add')
        }
      }
      if (selectionMode === 'box' && boxStart.current) {
        const start = boxStart.current
        setBox({
          left: Math.min(start.x, event.point.x),
          top: Math.min(start.y, event.point.y),
          width: Math.abs(event.point.x - start.x),
          height: Math.abs(event.point.y - start.y),
        })
      }
    }
    const onMouseUp = (event: MapMouseEvent & { originalEvent: MouseEvent }) => {
      if (selectionMode !== 'box' || !boxStart.current) return
      const start = boxStart.current
      const boxGeometry: [PointLike, PointLike] = [start, event.point]
      const features = map.queryRenderedFeatures(boxGeometry, { layers: [GRID_FILL] })
      const cellIds = [...new Set(features.map((feature) => feature.properties?.cell_id).filter(Boolean))]
      selectCells(cellIds, event.originalEvent.altKey ? 'remove' : 'add')
      boxStart.current = null
      setBox(null)
      map.dragPan.enable()
    }
    map.on('click', onClick)
    map.on('mousedown', onMouseDown)
    map.on('mousemove', onMouseMove)
    map.on('mouseup', onMouseUp)
    return () => {
      map.off('click', onClick)
      map.off('mousedown', onMouseDown)
      map.off('mousemove', onMouseMove)
      map.off('mouseup', onMouseUp)
    }
  }, [activeId, selectionMode, selectCells])

  return (
    <div className="map-shell">
      <div
        ref={container}
        className="model-map"
        aria-label="鲅鱼圈模型地图"
        data-grid-ready={gridReady}
      />
      {box && <div className="selection-box" style={box} />}
      <div className="map-coordinate-chip">EPSG 32651 · 30 M GRID</div>
    </div>
  )
}
