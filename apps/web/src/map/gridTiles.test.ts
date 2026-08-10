import { describe, expect, test } from 'vitest'
import {
  GridTileStore,
  parseGridTile,
  type GridManifest,
} from './gridTiles'

const descriptor = {
  id: 'r00000-c00000',
  demColumns: 4,
  rowStart: 0,
  rowStop: 2,
  columnStart: 0,
  columnStop: 2,
  cellCount: 3,
  topologyUrl: '/topology',
  fieldUrl: '/fields/{field}',
}

const manifest: GridManifest = {
  version: 1,
  tileSize: 256,
  demRows: 4,
  demColumns: 4,
  rowStart: 0,
  rowStop: 2,
  columnStart: 0,
  columnStop: 2,
  corners: [[122, 40.02], [122.02, 40.02], [122, 40], [122.02, 40]],
  fields: ['elevation', 'manningMiddle'],
  tiles: [descriptor],
}

function tileBuffer(fieldCode: number, values: number[] | null): ArrayBuffer {
  const bytes = fieldCode === 0 ? 1 : (values?.length ?? 0) * 4
  const buffer = new ArrayBuffer(32 + bytes)
  const view = new DataView(buffer)
  for (const [index, value] of [...'BQGT'].entries()) view.setUint8(index, value.charCodeAt(0))
  view.setUint16(4, 1, true)
  view.setUint16(6, 32, true)
  view.setUint32(8, fieldCode, true)
  view.setUint32(12, 0, true)
  view.setUint32(16, 0, true)
  view.setUint32(20, 2, true)
  view.setUint32(24, 2, true)
  view.setUint32(28, 3, true)
  if (fieldCode === 0) {
    new Uint8Array(buffer, 32, 1)[0] = 0b1011
  } else {
    new Float32Array(buffer, 32, values?.length ?? 0).set(values ?? [])
  }
  return buffer
}

describe('tiled simulation grid resource', () => {
  test('decodes topology masks and compact field planes', () => {
    const topology = parseGridTile(tileBuffer(0, null), descriptor, 'topology')
    expect([...topology.cellIndices]).toEqual([0, 1, 5])
    const field = parseGridTile(tileBuffer(1, [10, 11, 13]), descriptor, 'elevation')
    expect([...field.values]).toEqual([10, 11, 13])
  })

  test('assembles only requested fields from independently loaded tiles', async () => {
    const requested: string[] = []
    const resource = new GridTileStore(manifest, async (url) => {
      requested.push(url)
      if (url === '/topology') return tileBuffer(0, null)
      return url.endsWith('elevation')
        ? tileBuffer(1, [10, 11, 13])
        : tileBuffer(4, [0.05, 0.05, 0.05])
    })
    const topology = await resource.loadAll()
    expect([...topology.cellIndices]).toEqual([0, 1, 5])
    expect(requested).toEqual(['/topology'])
    const loaded = await resource.loadAll(['elevation', 'manningMiddle'])
    expect([...loaded.elevationM]).toEqual([10, 11, 13])
    for (const value of loaded.manningMiddle) expect(value).toBeCloseTo(0.05)
    expect(requested).toEqual(['/topology', '/fields/elevation', '/fields/manningMiddle'])
    expect(requested).toEqual(['/topology', '/fields/elevation', '/fields/manningMiddle'])
    const viewport = await resource.loadViewport(0, 2, 0, 2, ['elevation'])
    expect(viewport.cellCount).toBe(3)
    expect(viewport.tileIds).toEqual(['r00000-c00000'])
    expect([...viewport.tiles[0].fields.elevation ?? []]).toEqual([...loaded.elevationM])
    expect(viewport.cellAtLngLat(122.001, 40.019)).toBe('r0000-c0000')
  })
})
