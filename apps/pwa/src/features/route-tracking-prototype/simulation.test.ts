import { describe, expect, it } from 'vitest'
import { routeDistance, TEST_ROUTE, TEST_ROUTE_DISTANCE_M } from './simulation'

describe('route tracking prototype simulation', () => {
  it('keeps a deterministic forward route with meaningful distance', () => {
    expect(TEST_ROUTE).toHaveLength(19)
    expect(TEST_ROUTE_DISTANCE_M).toBeGreaterThan(1_000)
    expect(TEST_ROUTE_DISTANCE_M).toBeLessThan(2_000)
    expect(routeDistance(TEST_ROUTE.slice(0, 8))).toBeLessThan(TEST_ROUTE_DISTANCE_M)
  })
})
