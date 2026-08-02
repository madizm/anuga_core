import type { FlowField } from '../api/types'

type GridReference = Pick<FlowField, 'bounds' | 'corners'>

/** Map normalized raster coordinates to the exact projected grid footprint. */
export function gridUvToLngLat(
  field: GridReference,
  u: number,
  v: number,
): [number, number] {
  if (!field.corners) {
    const [west, south, east, north] = field.bounds
    return [west + u * (east - west), north + v * (south - north)]
  }
  const [northwest, northeast, southwest, southeast] = field.corners
  const northLongitude = northwest[0] + u * (northeast[0] - northwest[0])
  const northLatitude = northwest[1] + u * (northeast[1] - northwest[1])
  const southLongitude = southwest[0] + u * (southeast[0] - southwest[0])
  const southLatitude = southwest[1] + u * (southeast[1] - southwest[1])
  return [
    northLongitude + v * (southLongitude - northLongitude),
    northLatitude + v * (southLatitude - northLatitude),
  ]
}

/**
 * Invert the bilinear corner mapping. Four Newton iterations are ample for
 * kilometre-scale projected grids, whose geographic curvature is tiny.
 */
export function lngLatToGridUv(
  field: GridReference,
  longitude: number,
  latitude: number,
): [number, number] {
  const [west, south, east, north] = field.bounds
  let u = (longitude - west) / (east - west)
  let v = (north - latitude) / (north - south)
  if (!field.corners) return [u, v]
  const [nw, ne, sw, se] = field.corners
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const [mappedLongitude, mappedLatitude] = gridUvToLngLat(field, u, v)
    const residualLongitude = mappedLongitude - longitude
    const residualLatitude = mappedLatitude - latitude
    const duLongitude = (ne[0] - nw[0]) * (1 - v) + (se[0] - sw[0]) * v
    const duLatitude = (ne[1] - nw[1]) * (1 - v) + (se[1] - sw[1]) * v
    const dvLongitude = (sw[0] - nw[0]) * (1 - u) + (se[0] - ne[0]) * u
    const dvLatitude = (sw[1] - nw[1]) * (1 - u) + (se[1] - ne[1]) * u
    const determinant = duLongitude * dvLatitude - dvLongitude * duLatitude
    if (Math.abs(determinant) < 1e-18) break
    u -= (residualLongitude * dvLatitude - dvLongitude * residualLatitude) / determinant
    v -= (duLongitude * residualLatitude - residualLongitude * duLatitude) / determinant
  }
  return [u, v]
}

/** Advect UTM-aligned velocity components along the rotated raster axes. */
export function advectGridPosition(
  field: GridReference,
  longitude: number,
  latitude: number,
  velocity: [number, number],
  seconds: number,
): [number, number] {
  const [u, v] = lngLatToGridUv(field, longitude, latitude)
  const [widthMeters, heightMeters] = gridDimensionsMeters(field)
  return gridUvToLngLat(
    field,
    u + velocity[0] * seconds / Math.max(widthMeters, 0.001),
    v - velocity[1] * seconds / Math.max(heightMeters, 0.001),
  )
}

function gridDimensionsMeters(field: GridReference): [number, number] {
  const northwest = gridUvToLngLat(field, 0, 0)
  const northeast = gridUvToLngLat(field, 1, 0)
  const southwest = gridUvToLngLat(field, 0, 1)
  const southeast = gridUvToLngLat(field, 1, 1)
  return [
    (distanceMeters(northwest, northeast) + distanceMeters(southwest, southeast)) / 2,
    (distanceMeters(northwest, southwest) + distanceMeters(northeast, southeast)) / 2,
  ]
}

function distanceMeters(start: [number, number], end: [number, number]) {
  const meanLatitude = (start[1] + end[1]) / 2 * Math.PI / 180
  const east = (end[0] - start[0]) * 111_320 * Math.cos(meanLatitude)
  const north = (end[1] - start[1]) * 110_540
  return Math.hypot(east, north)
}
