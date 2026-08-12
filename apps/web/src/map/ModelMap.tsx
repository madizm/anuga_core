import type { FeatureCollection, LineString, Point, Polygon } from 'geojson'
import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl, { type GeoJSONSource, type Map, type MapMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type {
  EngineeringChannelFeature, FrictionScenario, HydraulicFeature, ResultQuantity,
} from '../api/types'
import { engineeringChannelSectionOverlay } from '../hydraulics/hydraulicFeatures'
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
import { SimulationGridLayer } from './SimulationGridLayer'
import { buildContourFeaturesForTile } from './contours'
import type { GridField, GridTileStore, GridViewport } from './gridTiles'
import { PreviewMapLayer } from '../preview/PreviewMapLayer'
import type { PreviewMode, PreviewSnapshot } from '../preview/types'
import {
  gridViewportRange,
  type GridRange,
} from './simulationGrid'

interface ModelMapProps {
  gridViewport?: GridViewport
  gridResource?: GridTileStore
  onGridViewportRequested?: (range: GridRange, fields: readonly GridField[]) => void
  demTilejsonUrl?: string
  terrainTilejsonUrl?: string
  cellSizeM?: number
  frictionScenario: FrictionScenario
  areaDrawMode?: 'rectangle' | 'polygon' | null
  onAreaDrawn?: (geometry: Polygon) => void
  hydraulicFeatures?: HydraulicFeature[]
  hydraulicMeshPreview?: FeatureCollection | null
  crossSectionSelection?: { featureId: string; sectionIndex: number } | null
  featureDrawMode?: 'levee' | 'simpleChannel' | 'engineeringChannel'
    | 'culvert' | 'bridge' | 'drainageOutlet' | 'breach' | null
  onFeatureDrawn?: (geometry: LineString | Polygon | Point) => void
  previewSnapshot?: PreviewSnapshot | null
  previewQuantity?: ResultQuantity
  previewFlowEnabled?: boolean
  previewMode?: PreviewMode
}

const DEM_SOURCE = 'model-dem'
const DEM_LAYER = 'model-dem-raster'
const CONTOUR_SOURCE = 'model-contours'
const CONTOUR_LINE = 'model-contours-line'
const CONTOUR_LABEL = 'model-contours-label'
const GRID_LAYER = 'model-grid'
const AREA_SOURCE = 'simulation-area-draft'
const AREA_FILL = 'simulation-area-draft-fill'
const AREA_LINE = 'simulation-area-draft-line'
const FEATURE_SOURCE = 'hydraulic-features'
const FEATURE_FILL = 'hydraulic-features-fill'
const FEATURE_LINE = 'hydraulic-features-line'
const FEATURE_POINT = 'hydraulic-features-point'
const FEATURE_DRAFT_SOURCE = 'hydraulic-feature-draft'
const FEATURE_DRAFT_LINE = 'hydraulic-feature-draft-line'
const CHANNEL_SECTION_SOURCE = 'engineering-channel-sections'
const CHANNEL_SECTION_LINE = 'engineering-channel-sections-line'
const CHANNEL_SECTION_POINT = 'engineering-channel-sections-point'
const MESH_PREVIEW_SOURCE = 'hydraulic-mesh-preview'
const MESH_PREVIEW_LINE = 'hydraulic-mesh-preview-line'

function raiseHydraulicLayers(map: Map) {
  raiseMapLayers(map, [
    FEATURE_FILL, FEATURE_LINE, FEATURE_POINT,
    FEATURE_DRAFT_LINE, MESH_PREVIEW_LINE,
    CHANNEL_SECTION_LINE, CHANNEL_SECTION_POINT,
  ])
}

const CONTOUR_MIN_ZOOM = 13
const GRID_REQUEST_DEBOUNCE_MS = 80

function scheduleIdle(callback: () => void): () => void {
  const idleWindow = window as Window & {
    requestIdleCallback?: (task: () => void, options?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (idleWindow.requestIdleCallback) {
    const id = idleWindow.requestIdleCallback(callback, { timeout: 500 })
    return () => idleWindow.cancelIdleCallback?.(id)
  }
  const timer = window.setTimeout(callback, 0)
  return () => window.clearTimeout(timer)
}

const MANNING_RANGES: Record<FrictionScenario, [number, number]> = {
  low: [0.03, 0.1],
  middle: [0.04, 0.16],
  high: [0.05, 0.2],
}

export function ModelMap({
  gridViewport,
  gridResource,
  onGridViewportRequested,
  demTilejsonUrl,
  terrainTilejsonUrl,
  cellSizeM,
  frictionScenario,
  areaDrawMode = null,
  onAreaDrawn,
  hydraulicFeatures = [],
  hydraulicMeshPreview = null,
  crossSectionSelection = null,
  featureDrawMode = null,
  onFeatureDrawn,
  previewSnapshot = null,
  previewQuantity = 'depth',
  previewFlowEnabled = true,
  previewMode = 'animated',
}: ModelMapProps) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const gridLayerRef = useRef<SimulationGridLayer | null>(null)
  const gridFitted = useRef(false)
  const previewLayerRef = useRef<PreviewMapLayer | null>(null)
  const brushVisited = useRef(new Set<string>())
  const boxStart = useRef<MapMouseEvent['point'] | null>(null)
  const areaStart = useRef<MapMouseEvent['lngLat'] | null>(null)
  const polygonPoints = useRef<[number, number][]>([])
  const featurePoints = useRef<[number, number][]>([])
  const [box, setBox] = useState<React.CSSProperties | null>(null)
  const [demReady, setDemReady] = useState(false)
  const [gridReady, setGridReady] = useState(false)
  const [mapReady, setMapReady] = useState(false)
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
  const contoursVisible = useLayerStore((state) => state.contours)
  const terrainEnabled = useTerrainStore((state) => state.modelEnabled)
  const terrainExaggeration = useTerrainStore((state) => state.exaggeration)
  const hillshade = useTerrainStore((state) => state.hillshade)
  const editingInTwoDimensions = Boolean(areaDrawMode || featureDrawMode)
    || selectionMode === 'brush' || selectionMode === 'box'
  const effectiveTerrain = terrainEnabled && !editingInTwoDimensions
    && !terrainError
  const demSurfaceVisible = baseFailed || (demVisible && !effectiveTerrain)
  const gridGeometry = useMemo(
    () => gridResource?.emptyGrid() ?? null,
    [gridResource],
  )
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map || !gridGeometry || !gridResource || !onGridViewportRequested) return
    const request = () => {
      const fields: GridField[] = []
      if (effectiveTerrain || contoursVisible) fields.push('elevation')
      if (buildingsVisible) fields.push('buildingFraction')
      if (manningVisible) fields.push(
        frictionScenario === 'low' ? 'manningLow'
          : frictionScenario === 'middle' ? 'manningMiddle' : 'manningHigh',
      )
      void onGridViewportRequested(gridViewportRange(map, gridGeometry), fields)
    }
    let timer: number | null = null
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(request, GRID_REQUEST_DEBOUNCE_MS)
    }
    map.on('moveend', schedule)
    schedule()
    return () => {
      map.off('moveend', schedule)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [
    buildingsVisible, effectiveTerrain, frictionScenario, gridGeometry, mapReady,
    contoursVisible, gridResource, manningVisible, onGridViewportRequested,
  ])

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
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
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
    setMapReady(true)
    return () => {
      setMapReady(false)
      previewLayerRef.current?.destroy()
      previewLayerRef.current = null
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const install = () => {
      if (!previewLayerRef.current) previewLayerRef.current = new PreviewMapLayer(map)
    }
    if (map.isStyleLoaded()) install()
    else map.once('load', install)
    return () => {
      map.off('load', install)
      previewLayerRef.current?.destroy()
      previewLayerRef.current = null
    }
  }, [])

  useEffect(() => {
    const layer = previewLayerRef.current
    if (!layer) return
    layer.setMode(previewMode)
    layer.setSnapshot(previewSnapshot)
    layer.setQuantity(previewQuantity)
    layer.setFlowEnabled(previewFlowEnabled)
    layer.setTerrainExaggeration(effectiveTerrain ? terrainExaggeration : 0)
  }, [effectiveTerrain, previewFlowEnabled, previewMode, previewQuantity, previewSnapshot, terrainExaggeration])

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
      map.addSource(CONTOUR_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: CONTOUR_LINE,
        type: 'line',
        source: CONTOUR_SOURCE,
        paint: {
          'line-color': ['case', ['get', 'isMajor'], '#f6d98c', '#d6bd79'],
          'line-width': ['case', ['get', 'isMajor'], 1.8, 0.85],
          'line-opacity': ['case', ['get', 'isMajor'], 0.95, 0.62],
        },
      })
      map.addLayer({
        id: CONTOUR_LABEL,
        type: 'symbol',
        source: CONTOUR_SOURCE,
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 260,
          'text-field': ['get', 'label'],
          'text-font': ['Open Sans Regular'],
          'text-size': ['case', ['get', 'isMajor'], 11, 10],
          'text-keep-upright': true,
          'text-padding': 3,
        },
        paint: {
          'text-color': ['case', ['get', 'isMajor'], '#f7e2a5', '#dfca91'],
          'text-halo-color': '#142329',
          'text-halo-width': 1.5,
          'text-halo-blur': 0.2,
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
      map.addSource(CHANNEL_SECTION_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: CHANNEL_SECTION_LINE,
        type: 'line',
        source: CHANNEL_SECTION_SOURCE,
        filter: ['==', ['get', 'kind'], 'section-line'],
        paint: {
          'line-color': ['case', ['get', 'active'], '#ffcc33', '#64d9ff'],
          'line-width': ['case', ['get', 'active'], 5, 2],
          'line-opacity': ['case', ['get', 'active'], 1, 0.65],
        },
      })
      map.addLayer({
        id: CHANNEL_SECTION_POINT,
        type: 'circle',
        source: CHANNEL_SECTION_SOURCE,
        filter: ['==', ['get', 'kind'], 'section-point'],
        paint: {
          'circle-color': ['case', ['get', 'active'], '#ffcc33', '#64d9ff'],
          'circle-radius': ['case', ['get', 'active'], 6, 3.5],
          'circle-stroke-color': '#06171d',
          'circle-stroke-width': 2,
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
    let cancelIdle = () => {}
    const empty = { type: 'FeatureCollection' as const, features: [] }
    const update = () => {
      cancelIdle()
      const visible = contoursVisible && map.getZoom() >= CONTOUR_MIN_ZOOM
      const visibility = visible ? 'visible' : 'none'
      if (map.getLayer(CONTOUR_LINE)) map.setLayoutProperty(CONTOUR_LINE, 'visibility', visibility)
      if (map.getLayer(CONTOUR_LABEL)) map.setLayoutProperty(CONTOUR_LABEL, 'visibility', visibility)
      if (!visible || !gridViewport) {
        (map.getSource(CONTOUR_SOURCE) as GeoJSONSource | undefined)?.setData(empty)
        if (container.current) {
          container.current.dataset.contourCount = '0'
          container.current.dataset.contourLabelCount = '0'
          container.current.dataset.contoursVisible = 'false'
        }
        return
      }
      cancelIdle = scheduleIdle(() => {
        const features = gridViewport.tiles.flatMap((tile) => (
          buildContourFeaturesForTile(tile, gridViewport.geometry).features
        ))
        const featureCollection = { type: 'FeatureCollection' as const, features }
        const source = map.getSource(CONTOUR_SOURCE) as GeoJSONSource | undefined
        source?.setData(featureCollection)
        if (container.current) {
          container.current.dataset.contourCount = String(features.length)
          container.current.dataset.contourLabelCount = String(features.length)
          container.current.dataset.contoursVisible = 'true'
        }
      })
    }
    const readyCleanup = syncWhenMapSourceReady(map, CONTOUR_SOURCE, update)
    map.on('moveend', update)
    map.on('zoomend', update)
    return () => {
      readyCleanup()
      map.off('moveend', update)
      map.off('zoomend', update)
      cancelIdle()
    }
  }, [contoursVisible, gridViewport])

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
      const source = map.getSource(CHANNEL_SECTION_SOURCE) as GeoJSONSource | undefined
      const channel = hydraulicFeatures.find((feature): feature is EngineeringChannelFeature => (
        feature.type === 'engineeringChannel'
        && feature.id === crossSectionSelection?.featureId
      ))
      const overlay = channel && crossSectionSelection
        ? engineeringChannelSectionOverlay(channel, crossSectionSelection.sectionIndex)
        : { type: 'FeatureCollection' as const, features: [] }
      source?.setData(overlay)
      if (container.current) {
        container.current.dataset.crossSectionCount = String(overlay.features.length / 2)
        container.current.dataset.activeCrossSection = crossSectionSelection
          ? String(crossSectionSelection.sectionIndex) : ''
      }
      raiseHydraulicLayers(map)
    }
    return syncWhenMapSourceReady(map, CHANNEL_SECTION_SOURCE, update)
  }, [crossSectionSelection, hydraulicFeatures])

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
      }, map.getLayer(GRID_LAYER) ? GRID_LAYER : undefined)
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
    if (!map) return
    if (!gridViewport) {
      gridLayerRef.current?.setViewport(null)
      setGridReady(false)
      gridFitted.current = false
      return
    }
    const install = () => {
      let layer = gridLayerRef.current
      if (!layer) {
        layer = new SimulationGridLayer(map)
        gridLayerRef.current = layer
        map.addLayer(layer)
        raiseHydraulicLayers(map)
      }
      layer.setViewport(gridViewport)
      setGridReady(gridViewport.cellCount > 0)
      if (!gridFitted.current) {
        const longitudes = gridViewport.geometry.corners.map((corner) => corner[0])
        const latitudes = gridViewport.geometry.corners.map((corner) => corner[1])
        map.fitBounds([
          [Math.min(...longitudes), Math.min(...latitudes)],
          [Math.max(...longitudes), Math.max(...latitudes)],
        ], { padding: 54, duration: 900 })
        gridFitted.current = true
      }
    }
    return syncWhenMapSourceReady(map, 'base-map', install)
  }, [gridViewport])

  useEffect(() => {
    const layer = gridLayerRef.current
    layer?.setFriction(frictionScenario)
    layer?.setVisibility({
      grid: gridVisible, buildings: buildingsVisible, manning: manningVisible,
    })
  }, [buildingsVisible, frictionScenario, gridVisible, manningVisible])
  useEffect(() => {
    const map = mapRef.current
    if (!map?.getLayer('base-map')) return
    map.setLayoutProperty('base-map', 'visibility', baseVisible ? 'visible' : 'none')
    if (map.getLayer(DEM_LAYER)) {
      map.setLayoutProperty(
        DEM_LAYER, 'visibility', demSurfaceVisible ? 'visible' : 'none',
      )
    }
  }, [baseVisible, demSurfaceVisible])

  useEffect(() => {
    const map = mapRef.current
    const layer = gridLayerRef.current
    if (!map || !layer) return
    layer.setTerrainEnabled(effectiveTerrain)
    const refresh = () => layer.refreshTerrain()
    if (effectiveTerrain) map.once('idle', refresh)
    return () => { map.off('idle', refresh) }
  }, [effectiveTerrain, gridViewport, terrainExaggeration])

  useEffect(() => {
    const locate = (event: Event) => {
      if (!gridViewport || !mapRef.current) return
      const bounds = gridViewport.cellBounds((event as CustomEvent<string[]>).detail)
      if (bounds) mapRef.current.fitBounds(bounds, { padding: 110, maxZoom: 17 })
    }
    window.addEventListener('locate-inlet', locate)
    return () => window.removeEventListener('locate-inlet', locate)
  }, [gridViewport])

  useEffect(() => {
    const next = new globalThis.Map<string, string>()
    for (const inlet of inlets) {
      for (const id of inlet.cellIds) next.set(id, inlet.displayColor)
    }
    gridLayerRef.current?.setSelections(next)
  }, [inlets, gridViewport])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !gridViewport || areaDrawMode || featureDrawMode) return
    const cellAt = (event: MapMouseEvent) => gridVisible
      ? gridViewport.cellAtLngLat(event.lngLat.lng, event.lngLat.lat)
      : null
    const operation = (event: MouseEvent) => (event.altKey ? 'remove' : event.shiftKey ? 'add' : 'toggle')
    const onClick = (event: MapMouseEvent & { originalEvent: MouseEvent }) => {
      if (selectionMode !== 'click' || !activeId) return
      const id = cellAt(event)
      if (id) selectCells([id], operation(event.originalEvent))
    }
    const onMouseDown = (event: MapMouseEvent & { originalEvent: MouseEvent }) => {
      if (!activeId) return
      if (selectionMode === 'brush') {
        brushVisited.current.clear()
        const id = cellAt(event)
        if (id) {
          brushVisited.current.add(id)
          selectCells([id], event.originalEvent.altKey ? 'remove' : 'add')
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
        const id = cellAt(event)
        if (id && !brushVisited.current.has(id)) {
          brushVisited.current.add(id)
          selectCells([id], event.originalEvent.altKey ? 'remove' : 'add')
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
      selectCells(
        gridViewport.cellsInScreenBox(map, start, event.point),
        event.originalEvent.altKey ? 'remove' : 'add',
      )
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
  }, [activeId, areaDrawMode, featureDrawMode, gridViewport, gridVisible, selectionMode, selectCells])

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

  const selectedChannel = hydraulicFeatures.find((feature): feature is EngineeringChannelFeature => (
    feature.type === 'engineeringChannel'
    && feature.id === crossSectionSelection?.featureId
  ))
  const selectedSection = crossSectionSelection
    ? selectedChannel?.crossSections[crossSectionSelection.sectionIndex] : undefined
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
        data-contour-count="0"
        data-contour-label-count="0"
        data-contours-visible="true"
        data-cross-section-count="0"
        data-active-cross-section=""
      />
      <TerrainControl
        scope="model"
        temporarilyFlat={editingInTwoDimensions}
        error={terrainError}
        onRetry={retryTerrain}
      />
      {box && <div className="selection-box" style={box} />}
      {selectedSection && crossSectionSelection && <div className="cross-section-map-chip" role="status">
        <span>ACTIVE CROSS SECTION</span>
        <strong>桩号 {selectedSection.distanceM.toFixed(1)} m</strong>
        <small>断面 {crossSectionSelection.sectionIndex + 1} / {selectedChannel?.crossSections.length}</small>
      </div>}
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
