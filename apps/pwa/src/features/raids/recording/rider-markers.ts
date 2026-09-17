import type { OneShotCoordinate } from '../../checkins/types'
import type { RouteTrackPoint, RouteTrackProjection } from '../types'

export type RiderMarker = {
  id: 'viewer' | 'navigator' | 'flock'
  point: RouteTrackPoint
  kind: 'participant' | 'navigator' | 'flock'
  label: string
  stale: boolean
}

const fresh = (point: RouteTrackPoint, now: number) => {
  const age = now - Date.parse(point.capturedAt)
  return age >= -5_000 && age <= 30_000
}

export function riderDistanceMeters(a: RouteTrackPoint, b: RouteTrackPoint): number {
  const radians = Math.PI / 180
  const h = Math.sin((b.latitude - a.latitude) * radians / 2) ** 2 +
    Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) *
    Math.sin((b.longitude - a.longitude) * radians / 2) ** 2
  return 12_742_000 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)))
}

export function selectRiderMarkers(input: {
  identityId: string
  navigatorUserId: string | null
  navigatorSampleAt: string | null
  location: OneShotCoordinate | null
  track: RouteTrackProjection | null
  live: boolean
  now: number
}): RiderMarker[] {
  const { location, identityId, navigatorUserId, navigatorSampleAt, track, live, now } = input
  const viewerIsNavigator = identityId === navigatorUserId
  const viewer: RiderMarker | null = location ? {
    id: 'viewer', point: location, kind: viewerIsNavigator ? 'navigator' : 'participant',
    label: viewerIsNavigator ? 'Моё положение — навигатор' : 'Моё положение', stale: !fresh(location, now),
  } : null
  // Never duplicate the navigator on their own phone, or borrow the last point
  // from an old navigator/lease when the new navigator has not sent a fix yet.
  const endpoint = track?.endPoint ?? (!track?.truncated ? track?.segments.filter(segment => segment.length).at(-1)?.at(-1) : null)
  const navigator = live && navigatorUserId && !viewerIsNavigator && endpoint && navigatorSampleAt &&
    Date.parse(endpoint.capturedAt) === Date.parse(navigatorSampleAt) ? endpoint : null
  if (!navigator) return viewer ? [viewer] : []
  const stale = !fresh(navigator, now)
  if (viewer && !viewer.stale && !stale && location!.accuracyMeters <= 50 && riderDistanceMeters(viewer.point, navigator) <= 50 + 1e-6) {
    // Anchor the flock to the viewer so “my location” retains its meaning.
    return [{ id: 'flock', point: viewer.point, kind: 'flock', label: 'Стая — вы и навигатор рядом, до 50 метров', stale: false }]
  }
  return [...(viewer ? [viewer] : []), {
    id: 'navigator', point: navigator, kind: 'navigator', stale,
    label: stale ? 'Навигатор — последнее известное положение' : 'Навигатор',
  }]
}
