import { describe, expect, it } from 'vitest'
import { selectRiderMarkers, riderDistanceMeters, FLOCK_RADIUS_METERS } from './rider-markers'
import type { RouteTrackPoint } from '../types'

const now = Date.parse('2026-09-17T12:00:00Z')
const point = (meters: number, age = 0): RouteTrackPoint => ({
  latitude: 56 + meters / 6_371_000 * 180 / Math.PI,
  longitude: 53, capturedAt: new Date(now - age).toISOString(),
})
function input(meters: number) {
  const endPoint = point(meters)
  return {
    identityId: 'participant', navigatorUserId: 'navigator', navigatorSampleAt: endPoint.capturedAt,
    location: { ...point(0), accuracyMeters: 8 },
    track: { segments: [[endPoint]], endPoint, pointCount: 1, truncated: false, updatedAt: endPoint.capturedAt, serverAt: endPoint.capturedAt },
    live: true, now,
  }
}

describe('participant and navigator map markers', () => {
  it('shows a white participant and a red navigator beyond 70 m', () => {
    expect(FLOCK_RADIUS_METERS).toBe(70)
    const markers = selectRiderMarkers(input(70.1))
    expect(markers.map(marker => marker.kind)).toEqual(['participant', 'navigator'])
    expect(riderDistanceMeters(markers[0]!.point, markers[1]!.point)).toBeCloseTo(70.1)
  })
  it.each([0, 20, 49.9, 50, 50.1, 60, 69.9, 70])('merges %s m into one flock at the participant coordinate', (meters) => {
    const data = input(meters)
    expect(selectRiderMarkers(data)).toEqual([expect.objectContaining({ id: 'flock', kind: 'flock', point: data.location, label: 'Стая — вы и навигатор рядом, до 70 метров' })])
  })
  it('splits again after leaving the radius and merges when returning', () => {
    expect(selectRiderMarkers(input(69))).toHaveLength(1)
    expect(selectRiderMarkers(input(71))).toHaveLength(2)
    expect(selectRiderMarkers(input(69))).toHaveLength(1)
  })
  it('does not duplicate the navigator on their own phone', () => {
    expect(selectRiderMarkers({ ...input(100), identityId: 'navigator' })).toEqual([
      expect.objectContaining({ id: 'viewer', kind: 'navigator' }),
    ])
  })
  it('shows the navigator alone when the participant has no GPS fix', () => {
    expect(selectRiderMarkers({ ...input(100), location: null }).map(marker => marker.id)).toEqual(['navigator'])
  })
  it('does not merge old or inaccurate coordinates into a live flock', () => {
    const data = input(20)
    const markers = selectRiderMarkers({ ...data, now: now + 30_001 })
    expect(markers).toHaveLength(2)
    expect(markers[1]).toMatchObject({ stale: true, label: 'Навигатор — последнее известное положение' })
    expect(selectRiderMarkers({ ...data, location: { ...data.location, accuracyMeters: 100 } })).toHaveLength(2)
  })
  it('never represents a previous navigator or a truncated tail as the current navigator', () => {
    const data = input(100)
    expect(selectRiderMarkers({ ...data, navigatorSampleAt: null }).map(marker => marker.id)).toEqual(['viewer'])
    expect(selectRiderMarkers({ ...data, navigatorSampleAt: point(0, 1000).capturedAt })).toHaveLength(1)
    expect(selectRiderMarkers({ ...data, track: { ...data.track, endPoint: undefined, truncated: true } })).toHaveLength(1)
    expect(selectRiderMarkers({ ...data, live: false })).toHaveLength(1)
  })
  it('retains freshness guards at the wider radius, then groups when both devices send fresh fixes', () => {
    const data = input(60)
    const nextNow = now + 30_001
    const viewerOnlyUpdated = { ...data, now: nextNow, location: { ...data.location, capturedAt: new Date(nextNow).toISOString() } }
    expect(selectRiderMarkers(viewerOnlyUpdated)).toEqual([
      expect.objectContaining({ id: 'viewer', stale: false }), expect.objectContaining({ id: 'navigator', stale: true }),
    ])
    const endpoint = { ...data.track.endPoint, capturedAt: new Date(nextNow).toISOString() }
    expect(selectRiderMarkers({ ...viewerOnlyUpdated, navigatorSampleAt: endpoint.capturedAt,
      track: { ...data.track, segments: [[endpoint]], endPoint: endpoint } })).toEqual([
      expect.objectContaining({ id: 'flock', stale: false }),
    ])
  })
})
