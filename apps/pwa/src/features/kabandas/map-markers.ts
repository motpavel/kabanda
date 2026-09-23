import type { YandexCoordinates, YandexMap, DisplayMapRuntime, YandexPlacemark } from './yandex-maps'

type MarkerView = {
  coordinate: YandexCoordinates
  properties: Record<string, unknown>
  options?: Record<string, unknown>
}
type Entry<Point> = { point: Point; marker: YandexPlacemark; view: MarkerView }
const equal = (left: unknown, right: unknown) => left === right || JSON.stringify(left) === JSON.stringify(right)

/** Retain SDK objects and their HTML layouts across polling and selection.
 * Only changed visual fields reach the SDK; click handlers read fresh data. */
export class MapMarkers<Point extends { id: string }> {
  private entries = new Map<string, Entry<Point>>()
  private layout: unknown
  constructor(private readonly map: YandexMap, private readonly runtime: DisplayMapRuntime,
    template: string, private readonly select: (point: Point) => void) {
    this.layout = runtime.templateLayoutFactory.createClass(template)
  }
  update(points: readonly Point[], present: (point: Point) => MarkerView) {
    const ids = new Set(points.map(point => point.id))
    for (const [id, entry] of this.entries) if (!ids.has(id)) {
      this.map.geoObjects.remove(entry.marker)
      this.entries.delete(id)
    }
    for (const point of points) {
      const view = present(point)
      const existing = this.entries.get(point.id)
      if (existing) {
        existing.point = point
        if (!equal(existing.view.coordinate, view.coordinate)) existing.marker.geometry?.setCoordinates(view.coordinate)
        for (const [key, value] of Object.entries(view.properties)) {
          if (!equal(existing.view.properties[key], value)) existing.marker.properties.set(key, value)
        }
        for (const [key, value] of Object.entries(view.options ?? {})) {
          if (!equal(existing.view.options?.[key], value)) existing.marker.options.set(key, value)
        }
        existing.view = view
        continue
      }
      const marker = new this.runtime.Placemark(view.coordinate, view.properties, { iconLayout: this.layout, ...view.options })
      const entry = { point, marker, view }
      marker.events.add('click', event => { event.stopPropagation?.(); this.select(entry.point) })
      this.entries.set(point.id, entry)
      this.map.geoObjects.add(marker)
    }
  }
  get(id: string) { return this.entries.get(id)?.point }
  clear() {
    for (const entry of this.entries.values()) this.map.geoObjects.remove(entry.marker)
    this.entries.clear()
  }
}
