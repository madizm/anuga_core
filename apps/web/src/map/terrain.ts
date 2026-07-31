import type { Map } from 'maplibre-gl'

export const TERRAIN_SOURCE = 'model-terrain-rgb'
export const HILLSHADE_LAYER = 'model-terrain-hillshade'

export function installTerrain(
  map: Map,
  tilejsonUrl: string,
  beforeLayerId?: string,
) {
  if (!map.getSource(TERRAIN_SOURCE)) {
    map.addSource(TERRAIN_SOURCE, {
      type: 'raster-dem',
      url: tilejsonUrl,
      tileSize: 256,
      maxzoom: 14,
      encoding: 'mapbox',
    })
  }
  if (!map.getLayer(HILLSHADE_LAYER)) {
    map.addLayer({
      id: HILLSHADE_LAYER,
      type: 'hillshade',
      source: TERRAIN_SOURCE,
      layout: { visibility: 'none' },
      paint: {
        'hillshade-exaggeration': 0.32,
        'hillshade-shadow-color': '#071419',
        'hillshade-highlight-color': '#d7e0d2',
        'hillshade-accent-color': '#52666a',
        'hillshade-illumination-anchor': 'map',
        'hillshade-illumination-direction': 325,
      },
    }, beforeLayerId)
  }
}

export function applyTerrain(
  map: Map,
  enabled: boolean,
  exaggeration: number,
  hillshade: boolean,
) {
  if (!map.getSource(TERRAIN_SOURCE)) return
  map.setTerrain(enabled ? { source: TERRAIN_SOURCE, exaggeration } : null)
  if (map.getLayer(HILLSHADE_LAYER)) {
    map.setLayoutProperty(
      HILLSHADE_LAYER,
      'visibility',
      enabled && hillshade ? 'visible' : 'none',
    )
  }
}

export function terrainSourceFromEvent(event: unknown) {
  const value = event as { sourceId?: string; error?: { message?: string } }
  return value.sourceId === TERRAIN_SOURCE
    || value.error?.message?.includes(TERRAIN_SOURCE) === true
}

export interface TerrainCamera {
  pitch: number
  bearing: number
}

export function setTerrainCamera(
  map: Map,
  enabled: boolean,
  saved: TerrainCamera,
  animate = true,
) {
  if (!enabled) {
    if (map.getPitch() > 0) {
      saved.pitch = map.getPitch()
      saved.bearing = map.getBearing()
    }
    map.easeTo({ pitch: 0, bearing: 0, duration: animate ? 420 : 0 })
    return
  }
  map.easeTo({
    pitch: saved.pitch,
    bearing: saved.bearing,
    duration: animate ? 620 : 0,
  })
}
