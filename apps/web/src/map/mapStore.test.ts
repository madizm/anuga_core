import { beforeEach, describe, expect, test } from 'vitest'
import { useLayerStore } from './mapStore'

beforeEach(() => {
  useLayerStore.setState({
    base: true,
    buildings: false,
    dem: true,
    grid: true,
    manning: false,
    contours: true,
  })
})

describe('model layer visibility', () => {
  test('DEM and Manning remain mutually exclusive surface layers', () => {
    useLayerStore.getState().setLayer('manning', true)

    expect(useLayerStore.getState().manning).toBe(true)
    expect(useLayerStore.getState().dem).toBe(false)

    useLayerStore.getState().setLayer('dem', true)

    expect(useLayerStore.getState().dem).toBe(true)
    expect(useLayerStore.getState().manning).toBe(false)
  })

  test('building coverage is an independent overlay', () => {
    useLayerStore.getState().setLayer('buildings', true)

    expect(useLayerStore.getState().buildings).toBe(true)
    expect(useLayerStore.getState().dem).toBe(true)
  })

  test('contours are an independent overlay', () => {
    useLayerStore.getState().setLayer('contours', false)

    expect(useLayerStore.getState().contours).toBe(false)
    expect(useLayerStore.getState().dem).toBe(true)
  })
})
