import { describe, expect, test } from 'vitest'
import { buildContourFeatures } from './contours'
import type { SimulationGrid } from './simulationGrid'

function gridWithSlope(): SimulationGrid {
  const elevationM = new Float32Array([
    0, 8, 16,
    0, 8, 16,
    0, 8, 16,
  ])
  return {
    cellCount: 9,
    demRows: 3,
    demColumns: 3,
    rowStart: 0,
    rowStop: 3,
    columnStart: 0,
    columnStop: 3,
    corners: [[0, 3], [3, 3], [0, 0], [3, 0]],
    cellIndices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]),
    elevationM,
    buildingFraction: new Float32Array(9),
    buildingDensityClass: new Float32Array(9),
    manningLow: new Float32Array(9),
    manningMiddle: new Float32Array(9),
    manningHigh: new Float32Array(9),
  }
}

describe('vector contour generation', () => {
  test('creates labelled contour features at the requested intervals', () => {
    const contours = buildContourFeatures(gridWithSlope(), {
      intervalM: 5,
      majorIntervalM: 10,
    })

    expect(contours.features.map((feature) => feature.properties.elevationM)).toEqual([
      5, 10, 15,
    ])
    expect(contours.features.map((feature) => feature.properties.isMajor)).toEqual([
      false, true, false,
    ])
    expect(contours.features[1].properties.label).toBe('10 m')
    expect(contours.features[1].geometry.type).toBe('LineString')
    expect(contours.features[1].geometry.coordinates.length).toBeGreaterThan(1)
    expect(contours.features[1].geometry.coordinates[0][0]).toBeCloseTo(1.25)
  })

  test('does not draw contours across cells outside the Simulation Area', () => {
    const grid = gridWithSlope()
    grid.cellCount = 8
    grid.cellIndices = new Uint32Array([0, 1, 2, 3, 5, 6, 7, 8])
    grid.elevationM = new Float32Array([0, 8, 16, 0, 16, 0, 8, 16])

    expect(buildContourFeatures(grid).features).toEqual([])
  })
})
