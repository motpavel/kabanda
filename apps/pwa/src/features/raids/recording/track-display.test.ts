import { describe, expect, it } from 'vitest'
import { displayTrackSegment } from './track-display'

const point = (x: number, y: number, seconds: number) => ({
  latitude: 56 + y / 111_320,
  longitude: 53 + x / (111_320 * Math.cos(56 * Math.PI / 180)),
  capturedAt: new Date(seconds * 1_000).toISOString(),
})
const xy = ([lat, lon]: readonly [number, number]) => [
  (lon - 53) * 111_320 * Math.cos(56 * Math.PI / 180), (lat - 56) * 111_320,
]
describe('display-only recorded track smoothing', () => {
  it('keeps raw data and exact endpoints, with smaller small-sample zigzags', () => {
    const raw = [point(0, 0, 0), point(20, 4, 2), point(40, -4, 4), point(60, 0, 6)]
    const saved = JSON.stringify(raw)
    const result = displayTrackSegment(raw)
    expect(JSON.stringify(raw)).toBe(saved)
    expect(result[0]).toEqual([raw[0]!.latitude, raw[0]!.longitude])
    expect(result.at(-1)).toEqual([raw[3]!.latitude, raw[3]!.longitude])
    expect(Math.max(...result.map((p) => Math.abs(xy(p)[1]!)))).toBeLessThan(4)
    expect(result.every((p) => p.every(Number.isFinite))).toBe(true)
  })
  it('rounds a real right turn locally instead of cutting across the block', () => {
    const result = displayTrackSegment([point(0, 0, 0), point(30, 0, 2), point(30, 30, 4)]).map(xy)
    expect(result.length).toBeGreaterThan(3)
    expect(result.some(([x, y]) => x! > 28 && y! < 2)).toBe(true)
    expect(result.every(([x, y]) => x! >= 0 && x! <= 30.0001 && y! >= 0 && y! <= 30.0001)).toBe(true)
  })
  it('preserves U-turns, duplicates, time gaps, sparse and single-point segments', () => {
    for (const raw of [
      [], [point(0, 0, 0)], [point(0, 0, 0), point(20, 0, 1)],
      [point(0, 0, 0), point(20, 0, 1), point(0, 0, 2)],
      [point(0, 0, 0), point(0, 0, 1), point(20, 0, 2)],
      [point(0, 0, 0), point(20, 4, 60), point(40, 0, 61)],
      [point(0, 0, 0), point(200, 4, 1), point(400, 0, 2)],
    ]) expect(displayTrackSegment(raw)).toEqual(raw.map(({ latitude, longitude }) => [latitude, longitude]))
  })
})
