import { describe, expect, it } from 'vitest'
import type { DensePreviewGrid } from './types'
import { compilePreviewHydraulics } from './previewHydraulics'

function grid(): DensePreviewGrid {
  return {
    width: 3,
    height: 3,
    cellSizeM: 30,
    corners: [[0, 3], [3, 3], [0, 0], [3, 0]],
    mask: new Float32Array(9).fill(1),
    elevationM: new Float32Array(9).fill(10),
    manningN: new Float32Array(9).fill(0.05),
    inletDepthRateMps: new Float32Array(9),
    inletXMomentumRate: new Float32Array(9),
    inletYMomentumRate: new Float32Array(9),
    initialState: new Float32Array(36),
    activeCellCount: 9,
    activeAreaM2: 8100,
    initialWaterVolumeM3: 0,
    inletDischargeM3s: 0,
  }
}

describe('compilePreviewHydraulics', () => {
  it('lowers the bed and overrides Manning inside a simple channel', () => {
    const result = compilePreviewHydraulics(grid(), [{
      id: 'channel-1', name: '河道', enabled: true, type: 'simpleChannel',
      geometry: {
        type: 'Polygon',
        coordinates: [[[0, 3], [3, 3], [3, 0], [0, 0], [0, 3]]],
      },
      elevationMode: 'lowerBy', depthM: 2, manningN: 0.03, maxTriangleAreaM2: 10,
    }])
    expect(result.bedElevationM.every((value) => value === 8)).toBe(true)
    expect(result.manningN.every((value) => Math.abs(value - 0.03) < 1e-6)).toBe(true)
    expect(result.approximatedFeatures).toEqual(['河道（简化河道）'])
  })

  it('compiles a levee to cell faces and a breach removes only its local face', () => {
    const levee = {
      id: 'levee-1', name: '堤防', enabled: true, type: 'levee' as const,
      geometry: { type: 'LineString' as const, coordinates: [[1, 0], [1, 3]] as [number, number][] },
      crestMode: 'absolute' as const, crestElevationM: 12, qFactor: 1,
    }
    const result = compilePreviewHydraulics(grid(), [levee])
    expect(result.wallX[1]).toBe(1)
    expect(result.crestX[1]).toBe(12)

    const breached = compilePreviewHydraulics(grid(), [{
      id: 'breach-1', name: '缺口', enabled: true, type: 'breach' as const,
      leveeId: 'levee-1', geometry: { type: 'Point' as const, coordinates: [1, 1.5] },
      widthM: 30, crestElevationM: 10,
    }, levee])
    expect(breached.wallX[1]).toBe(1)
    expect(breached.wallX[5]).toBe(0)
  })

  it('distributes a drainage outlet as a capacity sink', () => {
    const result = compilePreviewHydraulics(grid(), [{
      id: 'outlet-1', name: '排水口', enabled: true, type: 'drainageOutlet',
      geometry: { type: 'Point', coordinates: [1.5, 1.5] },
      capacityM3s: 9, intakeRadiusM: 30, fullCapacityDepthM: 0.3, blockage: 0,
    }])
    expect(result.outletCapacityM3s.reduce((sum, value) => sum + value, 0)).toBeCloseTo(9)
    expect(result.approximatedFeatures).toEqual(['排水口（排水口）'])
  })

  it('reports unsupported structures without compiling them', () => {
    const result = compilePreviewHydraulics(grid(), [{
      id: 'culvert-1', name: '涵洞', enabled: true, type: 'culvert',
      geometry: { type: 'LineString', coordinates: [[0, 1], [3, 1]] },
      shape: 'box', widthM: 2, heightM: 2, barrels: 1, blockage: 0, losses: 1, manningN: 0.013,
    }])
    expect(result.unsupportedFeatures).toEqual(['涵洞（涵洞）'])
    expect(result.links).toHaveLength(0)
  })
})
