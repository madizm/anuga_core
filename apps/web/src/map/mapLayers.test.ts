import { describe, expect, it, vi } from 'vitest'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { raiseMapLayers, syncWhenMapSourceReady } from './mapLayers'

describe('hydraulic map overlays', () => {
  it('raises completed and draft features above terrain and grid layers', () => {
    const moveLayer = vi.fn()
    const map = {
      getLayer: () => ({}),
      moveLayer,
    } as unknown as MapLibreMap

    raiseMapLayers(map, [
      'hydraulic-features-fill',
      'hydraulic-features-line',
      'hydraulic-features-point',
      'hydraulic-feature-draft-line',
      'hydraulic-mesh-preview-line',
    ])

    expect(moveLayer.mock.calls.map(([layer]) => layer)).toEqual([
      'hydraulic-features-fill',
      'hydraulic-features-line',
      'hydraulic-features-point',
      'hydraulic-feature-draft-line',
      'hydraulic-mesh-preview-line',
    ])
  })
  it('syncs a source even when the initial map load has already fired', () => {
    let sourceReady = false
    const listeners = new globalThis.Map<string, () => void>()
    const map = {
      getSource: () => (sourceReady ? {} : undefined),
      on: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener)
      }),
      off: vi.fn((event: string) => listeners.delete(event)),
    } as unknown as MapLibreMap
    const sync = vi.fn()

    const cleanup = syncWhenMapSourceReady(map, 'hydraulic-features', sync)
    expect(sync).not.toHaveBeenCalled()

    sourceReady = true
    listeners.get('styledata')?.()

    expect(sync).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)
    cleanup()
  })
})
