import type { FeatureCollection, Polygon } from 'geojson'
import { useEffect, useRef, useState } from 'react'
import maplibregl, { type GeoJSONSource, type Map, type MapMouseEvent, type PointLike } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FrictionScenario } from '../api/types'
import { useInletStore } from '../inlets/inletStore'
import { useLayerStore } from './mapStore'

interface ModelMapProps {
  grid?: FeatureCollection
  demTilejsonUrl?: string
  frictionScenario: FrictionScenario
  areaDrawMode?: 'rectangle' | 'polygon' | null
  onAreaDrawn?: (geometry: Polygon) => void
}

const DEM_SOURCE = 'model-dem'
const DEM_LAYER = 'model-dem-raster'
const BUILDING_LAYER = 'model-buildings'
const MANNING_LAYER = 'model-manning'
const GRID_SOURCE = 'model-grid'
const GRID_FILL = 'model-grid-fill'
const GRID_LINE = 'model-grid-line'
const AREA_SOURCE = 'simulation-area-draft'
const AREA_FILL = 'simulation-area-draft-fill'
const AREA_LINE = 'simulation-area-draft-line'

const MANNING_RANGES: Record<FrictionScenario, [number, number]> = {
  low: [0.03, 0.1],
  middle: [0.04, 0.16],
  high: [0.05, 0.2],
}

export function ModelMap({
  grid,
  demTilejsonUrl,
  frictionScenario,
  areaDrawMode = null,
  onAreaDrawn,
}: ModelMapProps) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const previousStates = useRef(new globalThis.Map<string, string>())
  const brushVisited = useRef(new Set<string>())
  const boxStart = useRef<MapMouseEvent['point'] | null>(null)
  const areaStart = useRef<MapMouseEvent['lngLat'] | null>(null)
  const polygonPoints = useRef<[number, number][]>([])
  const [box, setBox] = useState<React.CSSProperties | null>(null)
  const [demReady, setDemReady] = useState(false)
  const [gridReady, setGridReady] = useState(false)
  const inlets = useInletStore((state) => state.inlets)
  const activeId = useInletStore((state) => state.activeId)
  const selectionMode = useInletStore((state) => state.selectionMode)
  const selectCells = useInletStore((state) => state.selectCells)
  const baseVisible = useLayerStore((state) => state.base)
  const buildingsVisible = useLayerStore((state) => state.buildings)
  const demVisible = useLayerStore((state) => state.dem)
  const gridVisible = useLayerStore((state) => state.grid)
  const manningVisible = useLayerStore((state) => state.manning)

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
    if (!map) return
    const install = () => {
      if (map.getSource(AREA_SOURCE)) return
      map.addSource(AREA_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: AREA_FILL,
        type: 'fill',
        source: AREA_SOURCE,
        paint: { 'fill-color': '#00e5ff', 'fill-opacity': 0.13 },
      })
      map.addLayer({
        id: AREA_LINE,
        type: 'line',
        source: AREA_SOURCE,
        paint: {
          'line-color': '#65f1ff',
          'line-width': 2,
          'line-dasharray': [2, 1],
        },
      })
    }
    if (map.isStyleLoaded()) install()
    else map.once('load', install)
    return () => { map.off('load', install) }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !areaDrawMode) return
    const source = () => (
      map.getSource(AREA_SOURCE) as GeoJSONSource | undefined
    )
    source()?.setData({ type: 'FeatureCollection', features: [] })
    const show = (geometry: Polygon) => source()?.setData({
      type: 'Feature', properties: {}, geometry,
    })
    const rectangle = (
      start: MapMouseEvent['lngLat'],
      end: MapMouseEvent['lngLat'],
    ): Polygon => ({
      type: 'Polygon',
      coordinates: [[
        [start.lng, start.lat],
        [end.lng, start.lat],
        [end.lng, end.lat],
        [start.lng, end.lat],
        [start.lng, start.lat],
      ]],
    })
    const click = (event: MapMouseEvent) => {
      if (areaDrawMode !== 'polygon') return
      const point: [number, number] = [event.lngLat.lng, event.lngLat.lat]
      const previous = polygonPoints.current.at(-1)
      if (previous && previous[0] === point[0] && previous[1] === point[1]) return
      polygonPoints.current.push(point)
      if (polygonPoints.current.length >= 3) {
        show({
          type: 'Polygon',
          coordinates: [[...polygonPoints.current, polygonPoints.current[0]]],
        })
      }
    }
    const doubleClick = (event: MapMouseEvent) => {
      if (areaDrawMode !== 'polygon') return
      event.preventDefault()
      if (polygonPoints.current.length < 3) return
      const geometry: Polygon = {
        type: 'Polygon',
        coordinates: [[...polygonPoints.current, polygonPoints.current[0]]],
      }
      show(geometry)
      polygonPoints.current = []
      onAreaDrawn?.(geometry)
    }
    const mouseDown = (event: MapMouseEvent) => {
      if (areaDrawMode !== 'rectangle') return
      areaStart.current = event.lngLat
      map.dragPan.disable()
    }
    const mouseMove = (event: MapMouseEvent) => {
      if (areaDrawMode === 'rectangle' && areaStart.current) {
        show(rectangle(areaStart.current, event.lngLat))
      }
    }
    const mouseUp = (event: MapMouseEvent) => {
      if (areaDrawMode !== 'rectangle' || !areaStart.current) return
      const geometry = rectangle(areaStart.current, event.lngLat)
      areaStart.current = null
      map.dragPan.enable()
      show(geometry)
      onAreaDrawn?.(geometry)
    }
    polygonPoints.current = []
    if (map.getLayer(AREA_FILL)) map.moveLayer(AREA_FILL)
    if (map.getLayer(AREA_LINE)) map.moveLayer(AREA_LINE)
    map.getCanvas().style.cursor = 'crosshair'
    map.doubleClickZoom.disable()
    map.on('click', click)
    map.on('dblclick', doubleClick)
    map.on('mousedown', mouseDown)
    map.on('mousemove', mouseMove)
    map.on('mouseup', mouseUp)
    return () => {
      map.off('click', click)
      map.off('dblclick', doubleClick)
      map.off('mousedown', mouseDown)
      map.off('mousemove', mouseMove)
      map.off('mouseup', mouseUp)
      map.getCanvas().style.cursor = ''
      map.doubleClickZoom.enable()
      map.dragPan.enable()
      areaStart.current = null
      polygonPoints.current = []
    }
  }, [areaDrawMode, onAreaDrawn])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !demTilejsonUrl) return
    const install = () => {
      if (map.getSource(DEM_SOURCE)) return
      map.addSource(DEM_SOURCE, {
        type: 'raster',
        url: demTilejsonUrl,
        tileSize: 256,
      })
      map.addLayer({
        id: DEM_LAYER,
        type: 'raster',
        source: DEM_SOURCE,
        layout: { visibility: demVisible ? 'visible' : 'none' },
        paint: {
          'raster-opacity': 0.82,
          'raster-saturation': -0.18,
          'raster-contrast': 0.14,
          'raster-brightness-max': 0.78,
          'raster-fade-duration': 180,
        },
      }, map.getLayer(MANNING_LAYER)
        ? MANNING_LAYER
        : map.getLayer(BUILDING_LAYER)
          ? BUILDING_LAYER
          : map.getLayer(GRID_FILL) ? GRID_FILL : undefined)
      setDemReady(true)
    }
    if (map.isStyleLoaded()) install()
    else map.once('load', install)
    return () => { map.off('load', install) }
  }, [demTilejsonUrl, demVisible])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !grid) return
    const install = () => {
      if (map.getSource(GRID_SOURCE)) return
      map.addSource(GRID_SOURCE, { type: 'geojson', data: grid, promoteId: 'cell_id' })
      const [manningMinimum, manningMaximum] = MANNING_RANGES[frictionScenario]
      map.addLayer({
        id: MANNING_LAYER,
        type: 'fill',
        source: GRID_SOURCE,
        layout: { visibility: manningVisible ? 'visible' : 'none' },
        paint: {
          'fill-color': [
            'interpolate', ['linear'], ['get', `manning_${frictionScenario}`],
            manningMinimum, '#24758a',
            (manningMinimum + manningMaximum) / 2, '#d4b64f',
            manningMaximum, '#e5533d',
          ],
          'fill-opacity': 0.76,
        },
      })
      map.addLayer({
        id: BUILDING_LAYER,
        type: 'fill',
        source: GRID_SOURCE,
        filter: ['>', ['get', 'building_fraction'], 0],
        layout: { visibility: buildingsVisible ? 'visible' : 'none' },
        paint: {
          'fill-color': [
            'interpolate', ['linear'], ['get', 'building_fraction'],
            0, '#ffe17a',
            0.25, '#ffc247',
            0.5, '#ff8a3d',
            1, '#e94735',
          ],
          'fill-opacity': [
            'interpolate', ['linear'], ['get', 'building_fraction'],
            0, 0,
            0.1, 0.28,
            0.5, 0.68,
            1, 0.9,
          ],
        },
      })
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
  }, [grid, buildingsVisible, frictionScenario, manningVisible])

  useEffect(() => {
    const source = mapRef.current?.getSource(GRID_SOURCE) as (
      GeoJSONSource | undefined
    )
    source?.setData(grid ?? { type: 'FeatureCollection', features: [] })
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
    if (map.getLayer(DEM_LAYER)) {
      map.setLayoutProperty(DEM_LAYER, 'visibility', demVisible ? 'visible' : 'none')
    }
    if (map.getLayer(BUILDING_LAYER)) {
      map.setLayoutProperty(BUILDING_LAYER, 'visibility', buildingsVisible ? 'visible' : 'none')
    }
    if (map.getLayer(MANNING_LAYER)) {
      map.setLayoutProperty(MANNING_LAYER, 'visibility', manningVisible ? 'visible' : 'none')
    }
    if (map.getLayer(GRID_FILL)) {
      const visibility = gridVisible ? 'visible' : 'none'
      map.setLayoutProperty(GRID_FILL, 'visibility', visibility)
      map.setLayoutProperty(GRID_LINE, 'visibility', visibility)
    }
  }, [baseVisible, buildingsVisible, demVisible, gridVisible, grid, manningVisible])

  useEffect(() => {
    const map = mapRef.current
    if (!map?.getLayer(MANNING_LAYER)) return
    const [minimum, maximum] = MANNING_RANGES[frictionScenario]
    map.setPaintProperty(MANNING_LAYER, 'fill-color', [
      'interpolate', ['linear'], ['get', `manning_${frictionScenario}`],
      minimum, '#24758a',
      (minimum + maximum) / 2, '#d4b64f',
      maximum, '#e5533d',
    ])
  }, [frictionScenario])

  useEffect(() => {
    const map = mapRef.current
    if (!map || areaDrawMode) return
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
  }, [activeId, areaDrawMode, selectionMode, selectCells])

  const [manningMinimum, manningMaximum] = MANNING_RANGES[frictionScenario]

  return (
    <div className="map-shell">
      <div
        ref={container}
        className="model-map"
        aria-label="鲅鱼圈模型地图"
        data-dem-ready={demReady}
        data-grid-ready={gridReady}
      />
      {box && <div className="selection-box" style={box} />}
      <div className="map-coordinate-chip">EPSG 32651 · 30 M GRID</div>
      {((demVisible && demReady) || (buildingsVisible && gridReady) || (manningVisible && gridReady)) && (
        <div className="map-legends">
          {demVisible && demReady && (
            <div className="dem-legend" aria-label="DEM 高程图例">
              <span>DEM ELEVATION</span>
              <i />
              <div><b>0</b><b>25</b><b>50</b><b>75</b><b>100+ m</b></div>
            </div>
          )}
          {buildingsVisible && gridReady && (
            <div className="building-legend" aria-label="建筑覆盖率图例">
              <span>BUILDING COVERAGE</span>
              <i />
              <div><b>0</b><b>25</b><b>50</b><b>75</b><b>100%</b></div>
            </div>
          )}
          {manningVisible && gridReady && (
            <div className="manning-legend" aria-label="曼宁糙率图例">
              <span>MANNING · {frictionScenario.toUpperCase()}</span>
              <i />
              <div>
                <b>{manningMinimum.toFixed(2)}</b>
                <b>{((manningMinimum + manningMaximum) / 2).toFixed(2)}</b>
                <b>{manningMaximum.toFixed(2)}</b>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
