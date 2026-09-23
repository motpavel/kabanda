import type { YandexMap, DisplayMapRuntime, YandexPolyline } from '../../kabandas/yandex-maps'
import type { RouteTrackPoint } from '../types'
import { displayTrackSegment } from './track-display'

type TrackLayer = { points: readonly RouteTrackPoint[]; casing: YandexPolyline; line: YandexPolyline }
export type TrackLayers = Map<number, TrackLayer>

function sameSegment(left: readonly RouteTrackPoint[], right: readonly RouteTrackPoint[]) {
  return left === right || left.length === right.length && left.every((point, index) => {
    const next = right[index]!
    return point.latitude === next.latitude && point.longitude === next.longitude && point.capturedAt === next.capturedAt
  })
}

/** Keep map objects alive; unchanged, completed segments need no smoothing or repaint. */
export function updateTrackLayers(map: YandexMap, runtime: DisplayMapRuntime, layers: TrackLayers, segments: readonly (readonly RouteTrackPoint[])[]) {
  const paths = new Map<number, readonly RouteTrackPoint[]>()
  let previous: RouteTrackPoint | undefined
  segments.forEach((points, index) => {
    if (!points.length) return
    if (previous && Date.parse(points[0]!.capturedAt) > Date.parse(previous.capturedAt)) {
      // A dashed straight connection is an estimate across missing GPS, never
      // persisted as a sample or included in canonical distance/credits.
      paths.set(-index - 1, [previous, points[0]!])
    }
    if (points.length >= 2) paths.set(index, points)
    previous = points.at(-1)
  })
  for (const [index, layer] of layers) {
    if (paths.has(index)) continue
    map.geoObjects.remove(layer.casing)
    map.geoObjects.remove(layer.line)
    layers.delete(index)
  }
  paths.forEach((points, index) => {
    const previous = layers.get(index)
    if (previous && sameSegment(previous.points, points)) return
    const coordinates = displayTrackSegment(points)
    if (previous) {
      previous.casing.geometry.setCoordinates(coordinates)
      previous.line.geometry.setCoordinates(coordinates)
      previous.points = points
      return
    }
    const casing = new runtime.Polyline(coordinates, {}, { strokeColor: '#ffffff', strokeOpacity: .96, strokeWidth: 9, zIndex: 2 })
    const line = new runtime.Polyline(coordinates, {}, { strokeColor: '#17191b', strokeOpacity: 1, strokeWidth: 5, ...(index < 0 ? { strokeStyle: 'shortdash', strokeOpacity: .6 } : {}), zIndex: 3 })
    layers.set(index, { points, casing, line })
    map.geoObjects.add(casing)
    map.geoObjects.add(line)
  })
}
