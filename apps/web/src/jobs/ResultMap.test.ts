import { describe, expect, it, vi } from 'vitest'
import type { Map as MapLibreMap, RasterTileSource } from 'maplibre-gl'
import type { SimulationFrame } from '../api/types'
import {
  createBufferState,
  installBufferedFrame,
} from './bufferedRasterFrames'

function frame(frameIndex: number): SimulationFrame {
  const prefix = `/api/jobs/job-a/frames/${frameIndex}`
  return {
    jobId: 'job-a',
    frameIndex,
    timeSeconds: frameIndex * 10,
    maximumDepthM: frameIndex,
    maximumSpeedMps: frameIndex,
    wetAreaM2: frameIndex * 900,
    tilejson: {
      depth: `${prefix}/tilejson/depth`,
      stage: `${prefix}/tilejson/stage`,
      speed: `${prefix}/tilejson/speed`,
    },
    createdAt: '2026-01-01T00:00:00Z',
  }
}

function slowRasterMap() {
  const sources = new Map<string, RasterTileSource>()
  const layers = new Set<string>()
  const loaded = new Set<string>()
  const listeners = new Set<() => void>()
  const addedTiles: string[] = []
  const setTiles = vi.fn()

  const map = {
    getSource(id: string) {
      if (id === 'base') return {}
      return sources.get(id)
    },
    addSource(id: string, source: { tiles: string[] }) {
      addedTiles.push(source.tiles[0])
      sources.set(id, { setTiles } as unknown as RasterTileSource)
    },
    addLayer(layer: { id: string }) {
      layers.add(layer.id)
    },
    getLayer(id: string) {
      return layers.has(id) ? {} : undefined
    },
    setPaintProperty: vi.fn(),
    isSourceLoaded(id: string) {
      return loaded.has(id)
    },
    on(event: string, listener: () => void) {
      if (event === 'sourcedata') listeners.add(listener)
    },
    off(event: string, listener: () => void) {
      if (event === 'sourcedata') listeners.delete(listener)
    },
    once: vi.fn(),
  } as unknown as MapLibreMap

  return {
    map,
    addedTiles,
    setTiles,
    finish(sourceId: string) {
      loaded.add(sourceId)
      for (const listener of [...listeners]) listener()
    },
  }
}

describe('installBufferedFrame', () => {
  it('does not replace an in-flight frame and loads only the latest pending frame next', () => {
    const rasterMap = slowRasterMap()
    const state = createBufferState()
    const displayed = vi.fn()

    installBufferedFrame(rasterMap.map, state, frame(0), 'depth', displayed)
    installBufferedFrame(rasterMap.map, state, frame(1), 'depth', displayed)
    installBufferedFrame(rasterMap.map, state, frame(2), 'depth', displayed)

    expect(rasterMap.addedTiles).toEqual([
      '/api/jobs/job-a/frames/0/tiles/depth/{z}/{x}/{y}.png',
    ])
    expect(rasterMap.setTiles).not.toHaveBeenCalled()

    rasterMap.finish('result-1')

    expect(rasterMap.addedTiles).toEqual([
      '/api/jobs/job-a/frames/0/tiles/depth/{z}/{x}/{y}.png',
      '/api/jobs/job-a/frames/2/tiles/depth/{z}/{x}/{y}.png',
    ])
    expect(displayed).toHaveBeenCalledTimes(1)
    expect(displayed).toHaveBeenLastCalledWith(0)

    rasterMap.finish('result-0')
    expect(displayed).toHaveBeenLastCalledWith(2)
  })
})
