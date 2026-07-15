import { create } from 'zustand'

interface LayerState {
  base: boolean
  buildings: boolean
  dem: boolean
  grid: boolean
  manning: boolean
  setLayer: (layer: 'base' | 'buildings' | 'dem' | 'grid' | 'manning', visible: boolean) => void
}

export const useLayerStore = create<LayerState>((set) => ({
  base: true,
  buildings: false,
  dem: true,
  grid: true,
  manning: false,
  setLayer: (layer, visible) => set(
    layer === 'dem' && visible
      ? { dem: true, manning: false }
      : layer === 'manning' && visible
        ? { dem: false, manning: true }
        : { [layer]: visible },
  ),
}))
