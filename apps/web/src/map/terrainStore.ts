import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'

export type TerrainScope = 'model' | 'result'
export type TerrainExaggeration = 1 | 1.5 | 2

interface TerrainState {
  modelEnabled: boolean
  resultEnabled: boolean
  exaggeration: TerrainExaggeration
  hillshade: boolean
  setEnabled: (scope: TerrainScope, enabled: boolean) => void
  setExaggeration: (value: TerrainExaggeration) => void
  setHillshade: (enabled: boolean) => void
}

function mobileViewport() {
  if (typeof window === 'undefined') return false
  const mobileUserAgent = typeof navigator !== 'undefined'
    && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
  const compactPointer = typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 720px), (pointer: coarse)').matches
  return mobileUserAgent || compactPointer
}

const unavailableStorage: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
}

const preferenceStorage = createJSONStorage(() => (
  typeof localStorage === 'undefined' ? unavailableStorage : localStorage
))

export const useTerrainStore = create<TerrainState>()(persist(
  (set) => ({
    modelEnabled: false,
    resultEnabled: !mobileViewport(),
    exaggeration: 1.5,
    hillshade: true,
    setEnabled: (scope, enabled) => set(
      scope === 'model' ? { modelEnabled: enabled } : { resultEnabled: enabled },
    ),
    setExaggeration: (exaggeration) => set({ exaggeration }),
    setHillshade: (hillshade) => set({ hillshade }),
  }),
  {
    name: 'bayuquan-terrain-preferences-v1',
    storage: preferenceStorage,
    partialize: ({ modelEnabled, resultEnabled, exaggeration, hillshade }) => ({
      modelEnabled,
      resultEnabled,
      exaggeration,
      hillshade,
    }),
  },
))
