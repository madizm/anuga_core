import { describe, expect, test } from 'vitest'
import { buildSimulationGridInstances } from './SimulationGridLayer'
function tile() {
  return {
    descriptor: {
      id: 'r00000-c00000', rowStart: 10, rowStop: 13,
      columnStart: 20, columnStop: 23, cellCount: 3, demColumns: 200,
      topologyUrl: '/topology', fieldUrl: '/fields/{field}',
    },
    cellIndices: new Uint32Array([2020, 2021, 2221]),
    fields: {
      elevation: new Float32Array([10, 11, 12]),
      buildingFraction: new Float32Array([0.1, 0.2, 0.3]),
      manningLow: new Float32Array([0.03, 0.04, 0.05]),
      manningMiddle: new Float32Array([0.05, 0.06, 0.07]),
      manningHigh: new Float32Array([0.1, 0.11, 0.12]),
    },
  }
}

describe('instanced simulation grid data', () => {
  test('packs one instance per topology tile cell', () => {
    const result = buildSimulationGridInstances(tile(), new Map([['r0010-c0021', '#00e5ff']]))
    expect(result.count).toBe(3)
    expect(result.values.length).toBe(30)
    expect([...result.values.slice(0, 2)]).toEqual([10, 20])
    expect([...result.values.slice(10, 12)]).toEqual([10, 21])
    expect(result.values[17]).toBeCloseTo(0)
    expect(result.values[18]).toBeCloseTo(229 / 255)
    expect(result.values[19]).toBeCloseTo(1)
  })
})
