import { create } from 'zustand'

interface LayerState {
  base: boolean
  grid: boolean
  setLayer: (layer: 'base' | 'grid', visible: boolean) => void
}

export const useLayerStore = create<LayerState>((set) => ({
  base: true,
  grid: true,
  setLayer: (layer, visible) => set({ [layer]: visible }),
}))
