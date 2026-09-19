import { describe, expect, it } from 'vitest'
import { retainStop, type StopPoint } from './stop-context'
import { StationaryDisplay, stabilizeStationarySegment } from './stationary-display'
import { FlockDisplay } from './flock-display'
import { RouteChangeBuffer, type RouteChangePage, type RouteChangeRecord } from './route-changes'

const time = Date.parse('2026-09-19T12:00:00Z')
const fix = (meters: number, elapsed = 0, accuracyMeters = 8) => ({
  latitude: 56.86 + meters / 6_371_000 * 180 / Math.PI, longitude: 53.21,
  capturedAt: new Date(time + elapsed).toISOString(), accuracyMeters,
})
const point: StopPoint = { pointSnapshotId: 'point-a', sourcePointId: 'source-a', name: 'Остановка',
  latitude: 56.86, longitude: 53.21, distanceMeters: 0, creditedByMe: false, creditedByTeam: false }

describe('stop-scoped attendance context', () => {
  it('survives a missing nearby response, a lost GPS fix and boundary jitter', () => {
    const initial = retainStop(null, point, fix(0), time)!
    expect(retainStop(initial, null, null, time + 5000)).toEqual(initial)
    expect(retainStop(initial, null, fix(55, 5000), time + 5000)?.point).toEqual(point)
    expect(retainStop(initial, null, fix(45, 10_000), time + 10_000)?.point).toEqual(point)
  })
  it('does not transfer an old stop to an explicitly selected different point', () => {
    const initial = retainStop(null, point, fix(0), time)
    const next = { ...point, pointSnapshotId: 'point-b', sourcePointId: 'source-b' }
    expect(retainStop(initial, next, fix(0), time, true)?.point.pointSnapshotId).toBe('point-b')
  })
  it('releases only after distinct fresh GPS observations show actual departure', () => {
    const initial = retainStop(null, point, fix(0), time)!
    const first = retainStop(initial, null, fix(120, 1000), time + 1000)!
    expect(retainStop(first, null, fix(120, 1000), time + 9000)).toEqual(first)
    expect(retainStop(first, null, fix(125, 10_000), time + 10_000)).toBeNull()
  })
  it('does not use inaccurate, stale or future coordinates as departure evidence', () => {
    const initial = retainStop(null, point, fix(0), time)!
    expect(retainStop(initial, null, fix(200, 0, 100), time)).toEqual(initial)
    expect(retainStop(initial, null, fix(200, 0), time + 30_000)).toEqual(initial)
    expect(retainStop(initial, null, fix(200, 30_000), time)).toEqual(initial)
  })
})

describe('presentation-only stationary stabilization', () => {
  it('does not draw a zigzag for an oscillating stopped device inside 50m', () => {
    const raw = [0, 35, -24, 18, -45, 12].map((meters, index) => ({ ...fix(meters, index * 5000), speedMps: 0 }))
    const before = JSON.stringify(raw)
    expect(stabilizeStationarySegment(raw)).toHaveLength(1)
    expect(JSON.stringify(raw)).toBe(before)
  })
  it('preserves the real observation timestamp while holding a visual anchor', () => {
    const display = new StationaryDisplay()
    display.update(fix(0))
    expect(display.update(fix(25, 5000))).toEqual({ ...fix(0), capturedAt: fix(25, 5000).capturedAt })
  })
  it('releases coherent slow movement instead of snapping an entire ride to a 50m grid', () => {
    const display = new StationaryDisplay()
    const positions = [0, 3, 6, 9, 12].map((meters, index) => display.update(fix(meters, index * 5000)))
    expect(positions[3]!.latitude).toBe(fix(9).latitude)
    expect(positions[4]!.latitude).toBe(fix(12).latitude)
  })
  it('releases immediately for speed, movement out of the area and a new GPS session', () => {
    const display = new StationaryDisplay()
    display.update(fix(0))
    expect(display.update({ ...fix(8, 5000), speedMps: 2 }).latitude).toBe(fix(8).latitude)
    display.reset(); display.update(fix(0))
    expect(display.update(fix(51, 5000)).latitude).toBe(fix(51).latitude)
    display.reset(); display.update(fix(0))
    expect(display.update(fix(25, 40_000)).latitude).toBe(fix(25).latitude)
  })
})

const flockInput = (meters = 60, elapsed = 0) => ({
  identityId: 'rider', navigatorUserId: 'navigator', navigatorSampleAt: null,
  location: fix(meters, elapsed), track: null, live: true, now: time + elapsed,
  positions: [{ userId: 'navigator', ...fix(0, elapsed) }, { userId: 'rider', ...fix(meters, elapsed) }],
})
describe('full flock display', () => {
  it('groups the entire nearby active group, not only viewer and navigator', () => {
    const display = new FlockDisplay(), input = flockInput(60)
    const markers = display.select({ ...input, positions: [...input.positions, { userId: 'third', ...fix(30) }] })
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({ kind: 'flock', stale: false, members: ['navigator', 'rider', 'third'] })
  })
  it('joins at 70m and does not blink on one outside fix, but releases a sustained separation', () => {
    const display = new FlockDisplay()
    expect(display.select(flockInput(70))).toHaveLength(1)
    expect(display.select(flockInput(80, 1000))).toHaveLength(1)
    expect(display.select(flockInput(80, 10_000))).toHaveLength(2)
    expect(display.select(flockInput(69, 15_000))).toHaveLength(1)
    expect(display.select(flockInput(101, 20_000))).toHaveLength(2)
  })
  it('never keeps an old observation fresh merely to keep the group together', () => {
    const display = new FlockDisplay(), input = flockInput()
    expect(display.select(input)).toHaveLength(1)
    expect(display.select({ ...input, now: time + 30_001 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'navigator', stale: true }), expect.objectContaining({ kind: 'participant', stale: true }),
    ]))
    expect(display.select(flockInput(60, 31_000))).toHaveLength(1)
  })
  it('removes an absent member and does not invent an unreported navigator position', () => {
    const display = new FlockDisplay(), input = flockInput()
    display.select(input)
    expect(display.select({ ...input, positions: [{ userId: 'rider', ...fix(60) }] })).toHaveLength(1)
    expect(display.select({ ...input, positions: [], location: null })).toEqual([])
  })
})

const raidId = '11111111-1111-4111-8111-111111111111'
const record = (sequence: number, ordinal = sequence, continuesPrevious = true): RouteChangeRecord => ({
  ordinal: String(ordinal), sequence: String(sequence), leaseId: '22222222-2222-4222-8222-222222222222', generation: 1,
  ...fix(sequence, -10_000 + sequence * 1000), speedMps: 1, visible: true, continuesPrevious,
})
const page = (records: RouteChangeRecord[], cursor: string, reset = false): RouteChangePage => ({
  schemaVersion: 1, raidId, epoch: 'a'.repeat(64), reset, cursor, hasMore: false,
  serverAt: new Date(time).toISOString(), records,
})
describe('incremental route assembly', () => {
  it('repairs an already displayed gap when a late sequence and its successor arrive', () => {
    const buffer = new RouteChangeBuffer()
    const first = buffer.accept(page([record(1, 1, false), record(3, 2, false)], '2', true), raidId)
    expect(first.segments.map(segment => segment.length)).toEqual([1, 1])
    const repaired = buffer.accept(page([record(2, 3), record(3, 2)], '3'), raidId)
    expect(repaired.segments.map(segment => segment.length)).toEqual([3])
    expect(repaired.pointCount).toBe(3)
    expect(buffer.accept(page([record(2, 3), record(3, 2)], '3'), raidId).pointCount).toBe(3)
  })
  it('validates a complete page before clearing the old buffer or advancing the cursor', () => {
    const buffer = new RouteChangeBuffer()
    buffer.accept(page([record(1, 1, false)], '1', true), raidId)
    expect(() => buffer.accept(page([{ ...record(2), latitude: NaN }], '2', true), raidId)).toThrow()
    expect(buffer.cursor).toBe('1')
    expect(buffer.project(new Date(time).toISOString()).pointCount).toBe(1)
  })
  it('rejects backwards cursors and does not join distinct lease generations', () => {
    const buffer = new RouteChangeBuffer()
    buffer.accept(page([record(1, 1, false)], '1', true), raidId)
    expect(() => buffer.accept(page([], '0'), raidId)).toThrow()
    const projection = buffer.accept(page([{ ...record(1, 2), leaseId: '33333333-3333-4333-8333-333333333333', generation: 2 }], '2'), raidId)
    expect(projection.segments.map(segment => segment.length)).toEqual([1, 1])
  })
  it('can reveal a future-dated accepted fix when the real server clock reaches it', () => {
    const buffer = new RouteChangeBuffer()
    const future = { ...record(1), capturedAt: new Date(time + 1000).toISOString() }
    expect(buffer.accept(page([future], '1', true), raidId).pointCount).toBe(0)
    expect(buffer.accept({ ...page([], '1'), serverAt: new Date(time + 2000).toISOString() }, raidId).pointCount).toBe(1)
  })
})
