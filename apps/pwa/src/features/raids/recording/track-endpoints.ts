import type { RouteTrackPoint, RouteTrackProjection } from '../types'

export function trackEndpoints(track: RouteTrackProjection, completed: boolean): Array<{ point: RouteTrackPoint; kind: 'start' | 'finish' | 'both'; label: string }> {
  const first = track.startPoint ?? track.segments.find((segment) => segment.length)?.[0]
  const last = track.endPoint ?? (!track.truncated ? track.segments.filter((segment) => segment.length).at(-1)?.at(-1) : null)
  if (!first) return []
  if (!completed || !last) return [{ point: first, kind: 'start', label: 'Старт' }]
  const gap = Math.hypot((first.latitude - last.latitude) * 111320, (first.longitude - last.longitude) * 111320 * Math.cos(first.latitude * Math.PI / 180))
  if (gap < 15) return [{ point: first, kind: 'both', label: 'Старт / финиш' }]
  return [{ point: first, kind: 'start', label: 'Старт' }, { point: last, kind: 'finish', label: 'Финиш' }]
}
