import type { Map } from 'maplibre-gl'

export function raiseMapLayers(map: Map, layerIds: readonly string[]) {
  for (const layerId of layerIds) {
    if (map.getLayer(layerId)) map.moveLayer(layerId)
  }
}

export function syncWhenMapSourceReady(
  map: Map,
  sourceId: string,
  sync: () => void,
): () => void {
  const cleanup = () => {
    map.off('load', attempt)
    map.off('styledata', attempt)
  }
  const attempt = () => {
    if (!map.getSource(sourceId)) return
    sync()
    cleanup()
  }

  if (map.getSource(sourceId)) attempt()
  else {
    map.on('load', attempt)
    map.on('styledata', attempt)
  }
  return cleanup
}
