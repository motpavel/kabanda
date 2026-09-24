import { describe, expect, it } from 'vitest'
import { RouteChangeBuffer, type RouteChangePage, type RouteChangeRecord } from './route-changes'

const raidId = '11111111-1111-4111-8111-111111111111'
const time = 1_700_000_000_000
const record = (sequence: number, capturedAt = time + sequence * 1000): RouteChangeRecord => ({
  ordinal: String(sequence), sequence: String(sequence), leaseId: '22222222-2222-4222-8222-222222222222', generation: 1,
  latitude: 56.85, longitude: 53.2 + sequence * .0000001, capturedAt: new Date(capturedAt).toISOString(),
  accuracyMeters: 5, speedMps: 1, visible: true, continuesPrevious: sequence > 1,
})
const page = (records: RouteChangeRecord[], cursor: number, now = time + 20_000_000, reset = false): RouteChangePage => ({
  schemaVersion: 1, raidId, epoch: 'a'.repeat(64), reset, cursor: String(cursor), hasMore: false,
  serverAt: new Date(now).toISOString(), records,
})

describe('unchanged route geometry cache', () => {
  it('retains every vertex and endpoint for a long route across empty polling pages', () => {
    const buffer = new RouteChangeBuffer()
    for (let batch = 0; batch < 20; batch++) {
      buffer.accept(page(Array.from({ length: 300 }, (_, index) => record(batch * 300 + index + 1)), (batch + 1) * 300, undefined, batch === 0), raidId)
    }
    const initial = buffer.project(new Date(time + 20_000_000).toISOString())
    const later = buffer.accept(page([], 6000, time + 20_005_000), raidId)
    expect(later.pointCount).toBe(6000)
    expect(later.segments).toBe(initial.segments)
    expect(later.startPoint).toBe(initial.startPoint)
    expect(later.endPoint).toBe(initial.endPoint)
    expect(later.serverAt).toBe(new Date(time + 20_005_000).toISOString())
  })

  it('reveals future fixes exactly when eligible, and removes them after a clock rollback', () => {
    const buffer = new RouteChangeBuffer()
    const first = buffer.accept(page([record(1, time), record(2, time + 1000)], 2, time, true), raidId)
    const before = buffer.accept(page([], 2, time + 999), raidId)
    expect(before.segments).toBe(first.segments)
    expect(before.pointCount).toBe(1)
    const reached = buffer.accept(page([], 2, time + 1000), raidId)
    expect(reached.pointCount).toBe(2)
    const rollback = buffer.accept(page([], 2, time + 500), raidId)
    expect(rollback.pointCount).toBe(1)
  })

  it('invalidates on record correction, epoch reset and clear while preserving truncation metadata', () => {
    const buffer = new RouteChangeBuffer()
    const first = buffer.accept(page([record(1)], 1, undefined, true), raidId)
    expect(buffer.project(first.serverAt, true).segments).toBe(first.segments)
    expect(buffer.project(first.serverAt, true).truncated).toBe(true)
    const corrected = buffer.accept(page([{ ...record(1), visible: false }], 2), raidId)
    expect(corrected.pointCount).toBe(0)
    expect(corrected.segments).not.toBe(first.segments)
    const reset = buffer.accept({ ...page([record(2)], 1, undefined, true), epoch: 'b'.repeat(64) }, raidId)
    expect(reset.pointCount).toBe(1)
    expect(reset.endPoint?.capturedAt).toBe(record(2).capturedAt)
    buffer.clear()
    expect(buffer.project(first.serverAt).segments).toEqual([])
  })
})
