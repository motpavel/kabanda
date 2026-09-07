import type { RouteTrackPoint } from '../types'

type Coordinate = readonly [number, number]
const METERS_PER_DEGREE = 111_320

/** Display only: never feed these vertices into persistence, credits or distance.
 * Each input segment is independent. Preserve endpoints, sparse samples and
 * reversals; soften small GPS wobbles (max 3 m) and round corners within 2 m.
 */
export function displayTrackSegment(points: readonly RouteTrackPoint[]): Coordinate[] {
  const raw: Coordinate[] = points.map((point) => [point.latitude, point.longitude])
  if (raw.length < 3) return raw
  const scaleX = METERS_PER_DEGREE * Math.cos(raw[0]![0] * Math.PI / 180)
  const vector = (a: Coordinate, b: Coordinate) => [
    (b[0] - a[0]) * METERS_PER_DEGREE, (b[1] - a[1]) * scaleX,
  ] as const
  const length = (a: Coordinate, b: Coordinate) => Math.hypot(...vector(a, b))
  const blend = (a: Coordinate, b: Coordinate, ratio: number): Coordinate => [
    a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio,
  ]
  const continuous = (i: number) => {
    const elapsed = Date.parse(points[i]!.capturedAt) - Date.parse(points[i - 1]!.capturedAt)
    const distance = length(raw[i - 1]!, raw[i]!)
    return elapsed > 0 && elapsed <= 30_000 && distance >= .5 && distance <= 120
  }
  const turnCosine = (a: Coordinate, b: Coordinate, c: Coordinate) => {
    const incoming = vector(a, b)
    const outgoing = vector(b, c)
    return (incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) /
      (Math.hypot(...incoming) * Math.hypot(...outgoing))
  }
  const softened = raw.map((point, i): Coordinate => {
    if (!i || i === raw.length - 1 || !continuous(i) || !continuous(i + 1)) return point
    const before = raw[i - 1]!
    const after = raw[i + 1]!
    // Genuine turns stay anchored. Correct only small lateral oscillation.
    if (turnCosine(before, point, after) < Math.cos(Math.PI / 4)) return point
    const beforeLength = length(before, point)
    const target = blend(point, blend(before, after, beforeLength / (beforeLength + length(point, after))), .5)
    const shift = length(point, target)
    return blend(point, target, shift > 3 ? 3 / shift : 1)
  })
  const result: Coordinate[] = [raw[0]!]
  for (let i = 1; i < softened.length - 1; i += 1) {
    const before = softened[i - 1]!
    const point = softened[i]!
    const after = softened[i + 1]!
    if (!continuous(i) || !continuous(i + 1) || turnCosine(before, point, after) < -.7) {
      result.push(raw[i]!)
      continue
    }
    const incoming = length(before, point)
    const outgoing = length(point, after)
    const radius = Math.min(2, incoming * .2, outgoing * .2)
    if (radius < .1) { result.push(point); continue }
    const entry = blend(point, before, radius / incoming)
    const exit = blend(point, after, radius / outgoing)
    result.push(entry)
    // Quadratic curve stays in the local triangle, without overshoot.
    for (let step = 1; step <= 4; step += 1) {
      const t = step / 4
      result.push(blend(blend(entry, point, t), blend(point, exit, t), t))
    }
  }
  result.push(raw.at(-1)!)
  return result
}
