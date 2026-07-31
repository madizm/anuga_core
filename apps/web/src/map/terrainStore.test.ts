import { beforeEach, describe, expect, test } from 'vitest'
import { useTerrainStore } from './terrainStore'

beforeEach(() => {
  useTerrainStore.setState({
    modelEnabled: false,
    resultEnabled: true,
    exaggeration: 1.5,
    hillshade: true,
  })
})

describe('terrain display preferences', () => {
  test('editor and result terrain modes are independent', () => {
    useTerrainStore.getState().setEnabled('model', true)

    expect(useTerrainStore.getState().modelEnabled).toBe(true)
    expect(useTerrainStore.getState().resultEnabled).toBe(true)

    useTerrainStore.getState().setEnabled('result', false)

    expect(useTerrainStore.getState().modelEnabled).toBe(true)
    expect(useTerrainStore.getState().resultEnabled).toBe(false)
  })

  test('only supported reproducible exaggeration presets are stored', () => {
    useTerrainStore.getState().setExaggeration(2)
    useTerrainStore.getState().setHillshade(false)

    expect(useTerrainStore.getState().exaggeration).toBe(2)
    expect(useTerrainStore.getState().hillshade).toBe(false)
  })
})
