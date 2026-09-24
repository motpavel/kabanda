import { describe, expect, it } from 'vitest'
import { initialRaidMapView, routeTrackView, userMarkerCoordinate } from './RaidRouteMap'

describe('live raid route map', () => {
  const location = { latitude: 56.85, longitude: 53.2, accuracyMeters: 8, capturedAt: '2026-08-28T12:00:00.000Z' }
  it('starts directly at an already known viewer instead of loading the city first', () => {
    expect(initialRaidMapView([{ latitude: 56.9, longitude: 53.3 }], location, false))
      .toEqual({ center: [56.85, 53.2], zoom: 15, source: 'location' })
  })
  it('opens a completed ride at its overview even when viewer location is known', () => {
    const points = [{ latitude: 56.82, longitude: 53.16 }, { latitude: 56.88, longitude: 53.23 }]
    expect(initialRaidMapView(points, location, true, { width: 390, height: 400 }))
      .toEqual({ ...routeTrackView(points, { width: 390, height: 400 }), source: 'overview' })
    expect(initialRaidMapView([], null, false).source).toBe('default')
  })
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

  it('keeps both endpoints and labels inside a narrow completed-ride map', () => {
    const points = [{ latitude: 56.82, longitude: 53.16 }, { latitude: 56.88, longitude: 53.23 }]
    const viewport = { width: 330, height: 440 }
    const view = routeTrackView(points, viewport)
    const scale = 256 * 2 ** view.zoom
    const y = (latitude: number) => Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)) / (2 * Math.PI)
    expect((points[1]!.longitude - points[0]!.longitude) / 360 * scale).toBeLessThanOrEqual(viewport.width - 160)
    expect((y(points[1]!.latitude) - y(points[0]!.latitude)) * scale).toBeLessThanOrEqual(viewport.height - 144)
    expect(Number.isFinite(routeTrackView([points[0]!], viewport).zoom)).toBe(true)
  })

  it('never labels the team track endpoint as the viewer location', () => {
    expect(userMarkerCoordinate(null)).toBeNull()
    expect(userMarkerCoordinate({
      latitude: 56.85,
      longitude: 53.2,
      accuracyMeters: 8,
      capturedAt: '2026-08-28T12:00:00.000Z',
    })).toEqual([56.85, 53.2])
  })
})
