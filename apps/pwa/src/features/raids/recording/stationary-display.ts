import type { RouteTrackPoint } from '../types'
import { riderDistanceMeters } from './rider-markers'

export type DisplayFix = RouteTrackPoint & { accuracyMeters?: number; speedMps?: number | null }
const vector = (a: DisplayFix, b: DisplayFix) => ({
  x: (b.longitude - a.longitude) * Math.cos(a.latitude * Math.PI / 180), y: b.latitude - a.latitude,
})
function coherent(fixes: readonly DisplayFix[]): boolean {
  if (fixes.length < 4) return false
  const [a, b, c, d] = fixes.slice(-4) as [DisplayFix, DisplayFix, DisplayFix, DisplayFix]
  if (riderDistanceMeters(a, d) < 8) return false
  const vectors = [vector(a, b), vector(b, c), vector(c, d)]
  return vectors.slice(1).every((next, i) => {
    const previous = vectors[i]!
    const magnitude = Math.hypot(previous.x, previous.y) * Math.hypot(next.x, next.y)
    return magnitude > 0 && (previous.x * next.x + previous.y * next.y) / magnitude > .6
  })
}

/** Presentation-only deadband. Freshness still comes from the real sample's
 * capturedAt. Coherent slow movement, reported speed and exits from the 50 m
 * area release the anchor; no quantization of stored samples occurs. */
export class StationaryDisplay {
  private anchor: DisplayFix | null = null
  private samples: DisplayFix[] = []
  private movingUntil = 0
  reset() { this.anchor = null; this.samples = []; this.movingUntil = 0 }
  update<T extends DisplayFix>(point: T): T {
    const time = Date.parse(point.capturedAt)
    const previous = this.samples.at(-1)
    if (!Number.isFinite(time)) return point
    if (!this.anchor || (previous && (time < Date.parse(previous.capturedAt) || time - Date.parse(previous.capturedAt) > 30_000))) {
      this.anchor = point; this.samples = [point]; this.movingUntil = 0
      return point
    }
    if (!previous || point.capturedAt !== previous.capturedAt) {
      this.samples.push(point)
      this.samples = this.samples.slice(-4)
    }
    const moving = (point.speedMps != null && point.speedMps >= .8) || coherent(this.samples)
    if (moving) this.movingUntil = time + 10_000
    if (moving || time < this.movingUntil || riderDistanceMeters(this.anchor, point) > 50) {
      this.anchor = point
      return point
    }
    return { ...point, latitude: this.anchor.latitude, longitude: this.anchor.longitude }
  }
}

export function stabilizeStationarySegment(points: readonly DisplayFix[]): DisplayFix[] {
  const display = new StationaryDisplay()
  const result: DisplayFix[] = []
  for (const point of points) {
    const next = display.update(point)
    const previous = result.at(-1)
    if (previous && next.latitude === previous.latitude && next.longitude === previous.longitude) {
      // The newest observation time is retained; stopped samples do not add
      // geometric vertices. The input array and objects remain untouched.
      if (result.length > 1) result[result.length - 1] = next
      continue
    }
    result.push(next)
  }
  return result
}
