import { useEffect, useRef } from 'react'
import maplibregl, { type Map } from 'maplibre-gl'
import type { FullPreviewJob, FullPreviewPoint } from '../api/types'
import { BASE_MAP_ATTRIBUTION, BASE_MAP_TILE_URL } from '../map/baseMap'

export function FullPreviewMap({
  job,
  threshold,
  point,
  compareJob,
  onPoint,
}: {
  job: FullPreviewJob
  threshold: number
  point: FullPreviewPoint | null
  compareJob?: FullPreviewJob | null
  onPoint: (longitude: number, latitude: number) => void
}) {
  const container = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)
  const onPointRef = useRef(onPoint)
  onPointRef.current = onPoint

  useEffect(() => {
    if (!container.current || !job.result) return
    const map = new maplibregl.Map({
      container: container.current,
      style: {
        version: 8,
        sources: {
          base: {
            type: 'raster', tiles: [BASE_MAP_TILE_URL], tileSize: 256,
            attribution: BASE_MAP_ATTRIBUTION,
          },
        },
        layers: [{ id: 'base', type: 'raster', source: 'base' }],
      },
      bounds: job.result.bounds,
      fitBoundsOptions: { padding: 38 },
      attributionControl: false,
    })
    map.addControl(new maplibregl.NavigationControl(), 'top-right')
    map.on('click', (event) => onPointRef.current(
      event.lngLat.lng, event.lngLat.lat,
    ))
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [job.id, job.result])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !job.result) return
    const result = job.result
    const install = () => {
      for (const layerId of ['full-preview-depth', 'full-preview-compare']) {
        if (map.getLayer(layerId)) map.removeLayer(layerId)
      }
      for (const sourceId of ['full-preview-depth', 'full-preview-compare']) {
        if (map.getSource(sourceId)) map.removeSource(sourceId)
      }
      map.addSource('full-preview-depth', {
        type: 'raster',
        url: `${result.tilejsonUrl}?threshold_m=${threshold}`,
        tileSize: 256,
      })
      map.addLayer({
        id: 'full-preview-depth', type: 'raster', source: 'full-preview-depth',
        paint: { 'raster-opacity': compareJob?.result ? 0.52 : 0.88 },
      })
      if (compareJob?.result) {
        map.addSource('full-preview-compare', {
          type: 'raster',
          url: `${compareJob.result.tilejsonUrl}?threshold_m=${threshold}`,
          tileSize: 256,
        })
        map.addLayer({
          id: 'full-preview-compare', type: 'raster',
          source: 'full-preview-compare',
          paint: { 'raster-opacity': 0.48, 'raster-hue-rotate': 105 },
        })
      }
    }
    if (map.isStyleLoaded()) install()
    else map.once('load', install)
  }, [compareJob, job.result, threshold])

  return (
    <div className="full-preview-map-shell">
      <div ref={container} className="full-preview-map" />
      <div className="full-preview-watermark">
        非权威快览 <span>NOT FOR ENGINEERING DECISIONS</span>
      </div>
      <div className="full-preview-legend">
        <span>潜在最大水深 · m</span><i />
        <div><b>{threshold.toFixed(2)}</b><b>0.15</b><b>0.30</b><b>0.50</b><b>≥1.00</b></div>
      </div>
      {compareJob?.result && (
        <div className="compare-key">
          <span><i className="primary" />{job.rainfallDepthMm} mm</span>
          <span><i className="secondary" />{compareJob.rainfallDepthMm} mm</span>
        </div>
      )}
      {point && (
        <div className="full-preview-point">
          <span>MAP SAMPLE</span>
          <strong>{point.maximumDepthM == null ? '域外' : `${point.maximumDepthM.toFixed(2)} m`}</strong>
          <small>{point.longitude.toFixed(5)}, {point.latitude.toFixed(5)}</small>
        </div>
      )}
    </div>
  )
}
