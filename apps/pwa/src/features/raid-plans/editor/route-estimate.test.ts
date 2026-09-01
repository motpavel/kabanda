import { describe, expect, it } from 'vitest'
import { formatPlanDistance, geodesicRouteDistance } from './route-estimate'

describe('raid template distance fallback', () => {
  it('sums ordered straight-line segments for an honest editor fallback', () => {
    const points = [
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0.001 },
      { latitude: 0, longitude: 0.002 },
    ]
    const distance = geodesicRouteDistance(points)
    expect(distance).toBeGreaterThan(220)
    expect(distance).toBeLessThan(224)
    expect(formatPlanDistance(distance)).toBe('222 м')
  })
})
