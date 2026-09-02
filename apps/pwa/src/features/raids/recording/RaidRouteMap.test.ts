import { describe, expect, it } from 'vitest'
import { routeTrackView } from './RaidRouteMap'

describe('live raid route map', () => {
  it('centres a short track tightly around the traveled points', () => {
    const view = routeTrackView([
      { latitude: 56.85, longitude: 53.2, capturedAt: '2026-08-28T12:00:00.000Z' },
      { latitude: 56.854, longitude: 53.204, capturedAt: '2026-08-28T12:00:05.000Z' },
    ])
    expect(view.center[0]).toBeCloseTo(56.852)
    expect(view.center[1]).toBeCloseTo(53.202)
    expect(view.zoom).toBe(17)
  })

  it('zooms out to keep a district-sized track visible', () => {
    const view = routeTrackView([
      { latitude: 56.82, longitude: 53.16, capturedAt: '2026-08-28T12:00:00.000Z' },
      { latitude: 56.88, longitude: 53.23, capturedAt: '2026-08-28T13:00:00.000Z' },
    ])
    expect(view.center[0]).toBeCloseTo(56.85)
    expect(view.center[1]).toBeCloseTo(53.195)
    expect(view.zoom).toBe(13)
  })
})
