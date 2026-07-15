import { create } from 'zustand'
import type { Inlet } from '../api/types'

const COLORS = ['#00e5ff', '#ffcb45', '#ff6b4a', '#b78cff', '#55e093']

export type SelectionMode = 'click' | 'brush' | 'box'

interface InletState {
  inlets: Inlet[]
  activeId: string | null
  selectionMode: SelectionMode
  selectionError: string | null
  addInlet: () => void
  removeInlet: (id: string) => void
  setActive: (id: string) => void
  updateInlet: (id: string, patch: Partial<Inlet>) => void
  setSelectionMode: (mode: SelectionMode) => void
  selectCells: (cellIds: string[], operation?: 'toggle' | 'add' | 'remove') => void
  clearActive: () => void
  clearAllSelections: () => void
}

let inletCounter = 1

function makeInlet(index: number): Inlet {
  const number = inletCounter++
  return {
    id: `inlet-${String(number).padStart(3, '0')}`,
    name: `入口 ${number}`,
    enabled: true,
    cellIds: [],
    dischargeM3s: 100,
    velocityMode: 'zero',
    initialWaterLevelM: null,
    displayColor: COLORS[index % COLORS.length],
  }
}

const initial = makeInlet(0)

export const useInletStore = create<InletState>((set, get) => ({
  inlets: [initial],
  activeId: initial.id,
  selectionMode: 'click',
  selectionError: null,
  addInlet: () =>
    set((state) => {
      const inlet = makeInlet(state.inlets.length)
      return { inlets: [...state.inlets, inlet], activeId: inlet.id, selectionError: null }
    }),
  removeInlet: (id) =>
    set((state) => {
      const inlets = state.inlets.filter((item) => item.id !== id)
      return {
        inlets,
        activeId: state.activeId === id ? inlets[0]?.id ?? null : state.activeId,
        selectionError: null,
      }
    }),
  setActive: (id) => set({ activeId: id, selectionError: null }),
  updateInlet: (id, patch) =>
    set((state) => ({
      inlets: state.inlets.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    })),
  setSelectionMode: (selectionMode) => set({ selectionMode }),
  selectCells: (cellIds, operation = 'toggle') => {
    const { activeId, inlets } = get()
    if (!activeId) return
    const occupied = new Set(
      inlets.filter((item) => item.id !== activeId).flatMap((item) => item.cellIds),
    )
    const conflict = cellIds.find((cellId) => occupied.has(cellId))
    if (conflict) {
      set({ selectionError: `${conflict} 已属于其他入口` })
      return
    }
    set((state) => ({
      selectionError: null,
      inlets: state.inlets.map((inlet) => {
        if (inlet.id !== activeId) return inlet
        const selected = new Set(inlet.cellIds)
        for (const cellId of cellIds) {
          if (operation === 'remove') selected.delete(cellId)
          else if (operation === 'add') selected.add(cellId)
          else if (selected.has(cellId)) selected.delete(cellId)
          else selected.add(cellId)
        }
        return { ...inlet, cellIds: [...selected].sort() }
      }),
    }))
  },
  clearAllSelections: () => set((state) => ({
    inlets: state.inlets.map((inlet) => ({ ...inlet, cellIds: [] })),
    selectionError: null,
  })),
  clearActive: () => {
    const activeId = get().activeId
    if (activeId) get().updateInlet(activeId, { cellIds: [] })
    set({ selectionError: null })
  },
}))

export function isFourNeighbourConnected(cellIds: string[]): boolean {
  if (cellIds.length === 0) return false
  const cells = new Set(cellIds)
  const visited = new Set<string>()
  const pending = [cellIds[0]]
  while (pending.length) {
    const current = pending.pop()!
    if (visited.has(current)) continue
    visited.add(current)
    const match = /^r(\d{4})-c(\d{4})$/.exec(current)
    if (!match) return false
    const row = Number(match[1])
    const column = Number(match[2])
    const neighbours = [
      `r${String(row - 1).padStart(4, '0')}-c${String(column).padStart(4, '0')}`,
      `r${String(row + 1).padStart(4, '0')}-c${String(column).padStart(4, '0')}`,
      `r${String(row).padStart(4, '0')}-c${String(column - 1).padStart(4, '0')}`,
      `r${String(row).padStart(4, '0')}-c${String(column + 1).padStart(4, '0')}`,
    ]
    for (const neighbour of neighbours) {
      if (cells.has(neighbour) && !visited.has(neighbour)) pending.push(neighbour)
    }
  }
  return visited.size === cells.size
}
