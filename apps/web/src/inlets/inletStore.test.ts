import { beforeEach, describe, expect, it } from 'vitest'
import { isFourNeighbourConnected, useInletStore } from './inletStore'

beforeEach(() => {
  const current = useInletStore.getState()
  useInletStore.setState({
    inlets: [{
      id: 'inlet-a',
      name: 'A',
      enabled: true,
      cellIds: [],
      dischargeM3s: 10,
      velocityMode: 'zero',
      initialWaterLevelM: null,
      displayColor: '#00e5ff',
    }],
    activeId: 'inlet-a',
    selectionMode: 'click',
    selectionError: null,
    addInlet: current.addInlet,
    removeInlet: current.removeInlet,
    setActive: current.setActive,
    updateInlet: current.updateInlet,
    setSelectionMode: current.setSelectionMode,
    selectCells: current.selectCells,
    clearActive: current.clearActive,
  })
})

describe('grid connectivity', () => {
  it('accepts a four-neighbour chain', () => {
    expect(isFourNeighbourConnected([
      'r0001-c0001',
      'r0001-c0002',
      'r0002-c0002',
    ])).toBe(true)
  })

  it('rejects diagonal-only and separated selections', () => {
    expect(isFourNeighbourConnected(['r0001-c0001', 'r0002-c0002'])).toBe(false)
    expect(isFourNeighbourConnected(['r0001-c0001', 'r0001-c0003'])).toBe(false)
  })
})

describe('inlet cell ownership', () => {
  it('prevents a cell from being selected by two inlets', () => {
    const store = useInletStore.getState()
    store.selectCells(['r0001-c0001'], 'add')
    store.addInlet()
    useInletStore.getState().selectCells(['r0001-c0001'], 'add')

    const state = useInletStore.getState()
    expect(state.inlets[1].cellIds).toEqual([])
    expect(state.selectionError).toContain('已属于其他入口')
  })

  it('supports add, remove, and toggle operations', () => {
    const store = useInletStore.getState()
    store.selectCells(['r0001-c0001', 'r0001-c0002'], 'add')
    store.selectCells(['r0001-c0001'], 'remove')
    store.selectCells(['r0001-c0002'])

    expect(useInletStore.getState().inlets[0].cellIds).toEqual([])
  })
})
