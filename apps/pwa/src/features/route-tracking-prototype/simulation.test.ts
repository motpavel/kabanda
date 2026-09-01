import { describe, expect, it } from 'vitest'
import {
  routeDistance,
  splitRouteAtDistance,
  TEST_ROUTE,
  TEST_ROUTE_DISTANCE_M,
} from './simulation'

describe('route tracking prototype simulation', () => {
  it('keeps a deterministic forward route with meaningful distance', () => {
    expect(TEST_ROUTE).toHaveLength(19)
    expect(TEST_ROUTE_DISTANCE_M).toBeGreaterThan(1_000)
    expect(TEST_ROUTE_DISTANCE_M).toBeLessThan(2_000)
    expect(routeDistance(TEST_ROUTE.slice(0, 8))).toBeLessThan(TEST_ROUTE_DISTANCE_M)
  })

  it('splits a routed geometry at the live rider position', () => {
    const splitDistanceM = TEST_ROUTE_DISTANCE_M * 0.4
    const split = splitRouteAtDistance(TEST_ROUTE, splitDistanceM)

    expect(split.current).not.toBeNull()
    expect(split.traveled.at(-1)).toEqual(split.current)
    expect(split.remaining[0]).toEqual(split.current)
    expect(routeDistance(split.traveled)).toBeCloseTo(splitDistanceM, 3)
    expect(routeDistance(split.traveled) + routeDistance(split.remaining)).toBeCloseTo(TEST_ROUTE_DISTANCE_M, 3)
  })
})
