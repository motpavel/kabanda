import type { YandexMap, YandexMapsRuntime, YandexPolyline } from '../../kabandas/yandex-maps'
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
export function updateTrackLayers(map: YandexMap, runtime: YandexMapsRuntime, layers: TrackLayers, segments: readonly (readonly RouteTrackPoint[])[]) {
  for (const [index, layer] of layers) {
    if ((segments[index]?.length ?? 0) >= 2) continue
    map.geoObjects.remove(layer.casing)
    map.geoObjects.remove(layer.line)
    layers.delete(index)
  }
  segments.forEach((points, index) => {
    if (points.length < 2) return
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
    const line = new runtime.Polyline(coordinates, {}, { strokeColor: '#17191b', strokeOpacity: 1, strokeWidth: 5, zIndex: 3 })
    layers.set(index, { points, casing, line })
    map.geoObjects.add(casing)
    map.geoObjects.add(line)
  })
}
