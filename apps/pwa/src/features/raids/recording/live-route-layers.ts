import type { TailCoordinate, TailFrame } from './live-route-tail'

// Minimal structural map boundary, compatible with YandexMapsRuntime and also
// testable without loading a provider, DOM, React or the complete application.
type Line = { geometry: { setCoordinates: (points: readonly TailCoordinate[]) => void } }
type Layer = { casing: Line; line: Line; points: readonly TailCoordinate[] }
type MapBoundary = { geoObjects: { add: (value: object) => void; remove: (value: object) => void } }
type Runtime = { Polyline: new (points: readonly TailCoordinate[], properties?: Record<string, unknown>, options?: Record<string, unknown>) => Line }

export class LiveRouteLayers {
  private readonly history = new Map<number, Layer>()
  private historyRevision: TailFrame['history'] | null = null
  private tip: Layer | null = null
  constructor(private readonly map: MapBoundary, private readonly runtime: Runtime) {}

  update(frame: TailFrame) {
    if (frame.history !== this.historyRevision) {
      this.historyRevision = frame.history
      for (const [index, layer] of this.history) if (index >= frame.history.length) {
        this.remove(layer); this.history.delete(index)
      }
      frame.history.forEach((points, index) => {
        const current = this.history.get(index)
        if (current) this.set(current, points)
        else this.history.set(index, this.create(points, 'history'))
      })
    }
    if (frame.tip.length < 2) {
      if (this.tip) { this.remove(this.tip); this.tip = null }
    } else if (this.tip) this.set(this.tip, frame.tip)
    else this.tip = this.create(frame.tip, 'tip')
  }
  clear() {
    for (const layer of this.history.values()) this.remove(layer)
    this.history.clear(); this.historyRevision = null
    if (this.tip) this.remove(this.tip)
    this.tip = null
  }
  private create(points: readonly TailCoordinate[], part: string): Layer {
    const properties = { routePreview: true, routePreviewPart: part }
    const options = { hasBalloon: false, hasHint: false, interactiveZIndex: false, interactivityModel: 'default#transparent' }
    const casing = new this.runtime.Polyline(points, properties, { ...options, strokeColor: '#ffffff', strokeOpacity: .96, strokeWidth: 9, zIndex: 2 })
    // This is a temporary display extension, not a server-confirmed sample.
    const line = new this.runtime.Polyline(points, properties, { ...options, strokeColor: '#17191b', strokeOpacity: .8, strokeWidth: 5, zIndex: 3 })
    this.map.geoObjects.add(casing); this.map.geoObjects.add(line)
    return { casing, line, points }
  }
  private set(layer: Layer, points: readonly TailCoordinate[]) {
    if (layer.points === points || layer.points.length === points.length && layer.points.every((point, i) =>
      point[0] === points[i]![0] && point[1] === points[i]![1])) return
    layer.casing.geometry.setCoordinates(points); layer.line.geometry.setCoordinates(points)
    layer.points = points
  }
  private remove(layer: Layer) { this.map.geoObjects.remove(layer.casing); this.map.geoObjects.remove(layer.line) }
}
