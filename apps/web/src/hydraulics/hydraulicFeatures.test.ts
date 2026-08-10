import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LineString, Point, Polygon } from 'geojson'
import type { SimulationArea } from '../api/types'
import {
  createHydraulicFeature, engineeringChannelSectionOverlay, lineLengthM,
} from './hydraulicFeatures'

const area: SimulationArea = {
  id: 'a', areaHash: 'a', demProductId: 'dem', datasetVersion: 'v1',
  crs: 'EPSG:32651', cellCount: 100, areaM2: 90_000, cellSizeM: 30,
  triangleCount: 200, window: { rowStart: 0, rowStop: 10, columnStart: 0, columnStop: 10 },
  elevationM: { minimum: 1, maximum: 8, mean: 4 }, gridManifestUrl: '',
  boundaryCondition: 'transmissive',
}
const line: LineString = {
  type: 'LineString', coordinates: [[122.18, 40.3], [122.181, 40.3]],
}
const polygon: Polygon = {
  type: 'Polygon', coordinates: [[
    [122.18, 40.3], [122.181, 40.3], [122.181, 40.301],
    [122.18, 40.301], [122.18, 40.3],
  ]],
}


afterEach(() => vi.unstubAllGlobals())

describe('hydraulic feature defaults', () => {
  it('creates all three version feature families', () => {
    const levee = createHydraulicFeature('levee', line, area, [])
    const simple = createHydraulicFeature('simpleChannel', polygon, area, [levee])
    const engineering = createHydraulicFeature(
      'engineeringChannel', line, area, [levee, simple],
    )
    const culvert = createHydraulicFeature('culvert', line, area, [levee])
    const bridge = createHydraulicFeature('bridge', line, area, [levee])
    const drain = createHydraulicFeature(
      'drainageOutlet',
      { type: 'Point', coordinates: [122.1805, 40.3] },
      area,
      [levee],
    )
    const point: Point = { type: 'Point', coordinates: [122.1805, 40.3] }
    const breach = createHydraulicFeature('breach', point, area, [levee])

    expect(levee.type).toBe('levee')
    expect(simple.type).toBe('simpleChannel')
    expect(engineering.type).toBe('engineeringChannel')
    expect(engineering.type === 'engineeringChannel'
      && engineering.crossSections.at(-1)?.distanceM).toBeGreaterThan(80)
    expect(culvert.type).toBe('culvert')
    expect(bridge.type).toBe('bridge')
    expect(drain).toMatchObject({
      type: 'drainageOutlet', capacityM3s: 0.5,
      fullCapacityDepthM: 0.3, blockage: 0,
    })
    expect(breach.type === 'breach' && breach.leveeId).toBe(levee.id)
  })

  it('creates IDs when randomUUID is unavailable on an insecure origin', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (values: Uint8Array) => {
        values.set([0x12, 0x34, 0x56, 0x78])
        return values
      },
    })

    expect(createHydraulicFeature('levee', line, area, []).id)
      .toBe('levee-12345678')
  })

  it('computes projected line length closely enough for section chainage', () => {
    expect(lineLengthM(line.coordinates as [number, number][])).toBeCloseTo(85, -1)
  })

  it('locates channel sections along the centerline for the map overlay', () => {
    const feature = createHydraulicFeature('engineeringChannel', line, area, [])
    if (feature.type !== 'engineeringChannel') throw new Error('unexpected feature')

    const overlay = engineeringChannelSectionOverlay(feature, 1)
    const points = overlay.features.filter((item) => item.geometry.type === 'Point')

    expect(points).toHaveLength(2)
    expect(points[0].geometry).toMatchObject({ coordinates: line.coordinates[0] })
    expect(points[1].properties?.active).toBe(true)
    expect(overlay.features.filter((item) => item.geometry.type === 'LineString'))
      .toHaveLength(2)
  })
  it('requires a levee before creating a breach', () => {
    expect(() => createHydraulicFeature(
      'breach', { type: 'Point', coordinates: [122.18, 40.3] }, area, [],
    )).toThrow('请先绘制')
  })
})
