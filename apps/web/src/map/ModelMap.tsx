import type { FeatureCollection, LineString, Point, Polygon } from 'geojson'
import { useEffect, useRef, useState } from 'react'
import maplibregl, { type GeoJSONSource, type Map, type MapMouseEvent, type PointLike } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FrictionScenario, HydraulicFeature } from '../api/types'
import { useInletStore } from '../inlets/inletStore'
import { useLayerStore } from './mapStore'
import { raiseMapLayers, syncWhenMapSourceReady } from './mapLayers'
import { BASE_MAP_ATTRIBUTION, BASE_MAP_TILE_URL } from './baseMap'
import { TerrainControl } from './TerrainControl'
import {
  applyTerrain,
  HILLSHADE_LAYER,
  installTerrain,
  setTerrainCamera,
  TERRAIN_SOURCE,
  terrainSourceFromEvent,
} from './terrain'
import { useTerrainStore } from './terrainStore'

interface ModelMapProps {
  grid?: FeatureCollection
  demTilejsonUrl?: string
  terrainTilejsonUrl?: string
  cellSizeM?: number
  frictionScenario: FrictionScenario
  areaDrawMode?: 'rectangle' | 'polygon' | null
  onAreaDrawn?: (geometry: Polygon) => void
  hydraulicFeatures?: HydraulicFeature[]
  hydraulicMeshPreview?: FeatureCollection | null
  featureDrawMode?: 'levee' | 'simpleChannel' | 'engineeringChannel'
    | 'culvert' | 'bridge' | 'drainageOutlet' | 'breach' | null
  onFeatureDrawn?: (geometry: LineString | Polygon | Point) => void
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
const FEATURE_SOURCE = 'hydraulic-features'
const FEATURE_FILL = 'hydraulic-features-fill'
const FEATURE_LINE = 'hydraulic-features-line'
const FEATURE_POINT = 'hydraulic-features-point'
const FEATURE_DRAFT_SOURCE = 'hydraulic-feature-draft'
const FEATURE_DRAFT_LINE = 'hydraulic-feature-draft-line'
const MESH_PREVIEW_SOURCE = 'hydraulic-mesh-preview'
const MESH_PREVIEW_LINE = 'hydraulic-mesh-preview-line'

function raiseHydraulicLayers(map: Map) {
  raiseMapLayers(map, [
    FEATURE_FILL, FEATURE_LINE, FEATURE_POINT,
    FEATURE_DRAFT_LINE, MESH_PREVIEW_LINE,
  ])
}

const MANNING_RANGES: Record<FrictionScenario, [number, number]> = {
  low: [0.03, 0.1],
  middle: [0.04, 0.16],
  high: [0.05, 0.2],
}

export function ModelMap({
  grid,
  demTilejsonUrl,
  terrainTilejsonUrl,
  cellSizeM,
  frictionScenario,
  areaDrawMode = null,
  onAreaDrawn,
  hydraulicFeatures = [],
  hydraulicMeshPreview = null,
  featureDrawMode = null,
  onFeatureDrawn,
}: ModelMapProps) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const previousStates = useRef(new globalThis.Map<string, string>())
  const brushVisited = useRef(new Set<string>())
  const boxStart = useRef<MapMouseEvent['point'] | null>(null)
  const areaStart = useRef<MapMouseEvent['lngLat'] | null>(null)
  const polygonPoints = useRef<[number, number][]>([])
  const featurePoints = useRef<[number, number][]>([])
  const [box, setBox] = useState<React.CSSProperties | null>(null)
  const [demReady, setDemReady] = useState(false)
  const [gridReady, setGridReady] = useState(false)
  const [terrainReady, setTerrainReady] = useState(false)
  const [terrainError, setTerrainError] = useState<string | null>(null)
  const [terrainRetry, setTerrainRetry] = useState(0)
  const [baseFailed, setBaseFailed] = useState(false)
  const terrainCamera = useRef({ pitch: 55, bearing: -20 })
  const inlets = useInletStore((state) => state.inlets)
  const activeId = useInletStore((state) => state.activeId)
  const selectionMode = useInletStore((state) => state.selectionMode)
  const selectCells = useInletStore((state) => state.selectCells)
  const baseVisible = useLayerStore((state) => state.base)
  const buildingsVisible = useLayerStore((state) => state.buildings)
  const demVisible = useLayerStore((state) => state.dem)
  const gridVisible = useLayerStore((state) => state.grid)
  const manningVisible = useLayerStore((state) => state.manning)
  const terrainEnabled = useTerrainStore((state) => state.modelEnabled)
  const terrainExaggeration = useTerrainStore((state) => state.exaggeration)
  const hillshade = useTerrainStore((state) => state.hillshade)
  const editingInTwoDimensions = Boolean(areaDrawMode || featureDrawMode)
    || selectionMode === 'brush' || selectionMode === 'box'
  const effectiveTerrain = terrainEnabled && !editingInTwoDimensions
    && !terrainError
  const demSurfaceVisible = baseFailed || (demVisible && !effectiveTerrain)

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
            tiles: [BASE_MAP_TILE_URL],
            tileSize: 256,
            attribution: BASE_MAP_ATTRIBUTION,
          },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#081217' } },
          {
            id: 'base-map',
            type: 'raster',
            source: 'base-map',
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
      map.addSource(FEATURE_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: FEATURE_FILL,
        type: 'fill',
        source: FEATURE_SOURCE,
        filter: ['==', '$type', 'Polygon'],
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.22 },
      })
      map.addLayer({
        id: FEATURE_LINE,
        type: 'line',
        source: FEATURE_SOURCE,
        filter: ['in', '$type', 'LineString', 'Polygon'],
        paint: { 'line-color': ['get', 'color'], 'line-width': 4 },
      })
      map.addLayer({
        id: FEATURE_POINT,
        type: 'circle',
        source: FEATURE_SOURCE,
        filter: ['==', '$type', 'Point'],
        paint: {
          'circle-color': ['get', 'color'],
          'circle-radius': 7,
          'circle-stroke-color': '#051319',
          'circle-stroke-width': 2,
        },
      })
      map.addSource(FEATURE_DRAFT_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: FEATURE_DRAFT_LINE,
        type: 'line',
        source: FEATURE_DRAFT_SOURCE,
        paint: {
          'line-color': '#ffcc33',
          'line-width': 3,
          'line-dasharray': [1, 1],
        },
      })
      map.addSource(MESH_PREVIEW_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: MESH_PREVIEW_LINE,
        type: 'line',
        source: MESH_PREVIEW_SOURCE,
        paint: {
          'line-color': '#63f1ff',
          'line-width': 0.7,
          'line-opacity': 0.58,
        },
      })
    }
    if (map.isStyleLoaded()) install()
    else map.once('load', install)
    return () => { map.off('load', install) }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const update = () => {
      const source = map.getSource(FEATURE_SOURCE) as GeoJSONSource | undefined
      const features: FeatureCollection['features'] = hydraulicFeatures
        .filter((feature) => feature.enabled).map((feature) => ({
          type: 'Feature',
          properties: {
            id: feature.id,
            type: feature.type,
            color: feature.type === 'levee' ? '#ffb020'
              : feature.type === 'simpleChannel' || feature.type === 'engineeringChannel' ? '#00a8ff'
                : feature.type === 'breach' ? '#ff3b5c'
                  : feature.type === 'drainageOutlet' ? '#39e68b' : '#c880ff',
          },
          geometry: feature.geometry,
        }))
      source?.setData({ type: 'FeatureCollection', features })
      if (source && container.current) {
        container.current.dataset.hydraulicSourceCount = String(features.length)
      }
    }
    const sync = () => {
      update()
      raiseHydraulicLayers(map)
    }
    return syncWhenMapSourceReady(map, FEATURE_SOURCE, sync)
  }, [hydraulicFeatures])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const update = () => {
      const source = map.getSource(MESH_PREVIEW_SOURCE) as GeoJSONSource | undefined
      source?.setData(hydraulicMeshPreview ?? {
        type: 'FeatureCollection', features: [],
      })
      if (map.getLayer(MESH_PREVIEW_LINE)) map.moveLayer(MESH_PREVIEW_LINE)
    }
    return syncWhenMapSourceReady(map, MESH_PREVIEW_SOURCE, update)
  }, [hydraulicMeshPreview])

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
    if (!map || !featureDrawMode) return
    const source = () => map.getSource(FEATURE_DRAFT_SOURCE) as GeoJSONSource | undefined
    const clear = () => source()?.setData({ type: 'FeatureCollection', features: [] })
    const show = () => {
      if (featurePoints.current.length < 2) return
      const geometry: LineString | Polygon = featureDrawMode === 'simpleChannel'
        ? { type: 'Polygon', coordinates: [[...featurePoints.current, featurePoints.current[0]]] }
        : { type: 'LineString', coordinates: featurePoints.current }
      source()?.setData({ type: 'Feature', properties: {}, geometry })
    }
    const complete = () => {
      if (featureDrawMode === 'simpleChannel') {
        if (featurePoints.current.length < 3) return
        onFeatureDrawn?.({
          type: 'Polygon',
          coordinates: [[...featurePoints.current, featurePoints.current[0]]],
        })
      } else {
        if (featurePoints.current.length < 2) return
        onFeatureDrawn?.({ type: 'LineString', coordinates: [...featurePoints.current] })
      }
      featurePoints.current = []
      clear()
    }
    const click = (event: MapMouseEvent) => {
      const point: [number, number] = [event.lngLat.lng, event.lngLat.lat]
      if (featureDrawMode === 'breach' || featureDrawMode === 'drainageOutlet') {
        onFeatureDrawn?.({ type: 'Point', coordinates: point })
        clear()
        return
      }
      const previous = featurePoints.current.at(-1)
      if (previous && previous[0] === point[0] && previous[1] === point[1]) return
      featurePoints.current.push(point)
      show()
      if ((featureDrawMode === 'culvert' || featureDrawMode === 'bridge')
        && featurePoints.current.length === 2) complete()
    }
    const doubleClick = (event: MapMouseEvent) => {
      event.preventDefault()
      if (featureDrawMode === 'breach' || featureDrawMode === 'drainageOutlet'
        || featureDrawMode === 'culvert' || featureDrawMode === 'bridge') return
      complete()
    }
    featurePoints.current = []
    clear()
    map.getCanvas().style.cursor = 'crosshair'
    map.doubleClickZoom.disable()
    map.on('click', click)
    map.on('dblclick', doubleClick)
    return () => {
      map.off('click', click)
      map.off('dblclick', doubleClick)
      map.getCanvas().style.cursor = ''
      map.doubleClickZoom.enable()
      featurePoints.current = []
      clear()
    }
  }, [featureDrawMode, onFeatureDrawn])

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
        layout: { visibility: demSurfaceVisible ? 'visible' : 'none' },
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
      raiseHydraulicLayers(map)
      setDemReady(true)
    }
    if (map.isStyleLoaded()) install()
    else map.once('load', install)
    return () => { map.off('load', install) }
  }, [demSurfaceVisible, demTilejsonUrl])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !terrainTilejsonUrl) return
    const install = () => {
      try {
        installTerrain(map, terrainTilejsonUrl, AREA_FILL)
        setTerrainReady(true)
      } catch (error) {
        setTerrainError((error as Error).message || '地形初始化失败')
      }
    }
    const onError = (event: unknown) => {
      const sourceId = (event as { sourceId?: string }).sourceId
      if (terrainSourceFromEvent(event)) {
        setTerrainError('地形瓦片加载失败')
      } else if (sourceId === 'base-map') {
        setBaseFailed(true)
      }
    }
    if (map.isStyleLoaded()) install()
    else map.once('load', install)
    map.on('error', onError)
    return () => {
      map.off('load', install)
      map.off('error', onError)
    }
  }, [terrainTilejsonUrl, terrainRetry])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !terrainReady) return
    try {
      applyTerrain(map, effectiveTerrain, terrainExaggeration, hillshade)
    } catch (error) {
      setTerrainError((error as Error).message || '地形渲染失败')
    }
  }, [effectiveTerrain, hillshade, terrainExaggeration, terrainReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !terrainReady) return
    setTerrainCamera(map, effectiveTerrain, terrainCamera.current)
  }, [effectiveTerrain, terrainReady])

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
      raiseHydraulicLayers(map)
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
      map.setLayoutProperty(
        DEM_LAYER,
        'visibility',
        demSurfaceVisible ? 'visible' : 'none',
      )
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
  }, [baseVisible, buildingsVisible, demSurfaceVisible, gridVisible, grid, manningVisible])

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
    if (!map || areaDrawMode || featureDrawMode) return
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
  }, [activeId, areaDrawMode, featureDrawMode, selectionMode, selectCells])

  const retryTerrain = () => {
    const map = mapRef.current
    if (map) {
      map.setTerrain(null)
      if (map.getLayer(HILLSHADE_LAYER)) map.removeLayer(HILLSHADE_LAYER)
      if (map.getSource(TERRAIN_SOURCE)) map.removeSource(TERRAIN_SOURCE)
    }
    setTerrainError(null)
    setTerrainReady(false)
    setTerrainRetry((value) => value + 1)
  }

  const [manningMinimum, manningMaximum] = MANNING_RANGES[frictionScenario]

  return (
    <div className="map-shell">
      <div
        ref={container}
        className="model-map"
        aria-label="鲅鱼圈模型地图"
        data-dem-ready={demReady}
        data-grid-ready={gridReady}
        data-hydraulic-source-count="0"
      />
      <TerrainControl
        scope="model"
        temporarilyFlat={editingInTwoDimensions}
        error={terrainError}
        onRetry={retryTerrain}
      />
      {box && <div className="selection-box" style={box} />}
      <div className="map-coordinate-chip">EPSG 32651 · {cellSizeM ?? '—'} M GRID</div>
      {((demSurfaceVisible && demReady) || (buildingsVisible && gridReady) || (manningVisible && gridReady)) && (
        <div className="map-legends">
          {demSurfaceVisible && demReady && (
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
