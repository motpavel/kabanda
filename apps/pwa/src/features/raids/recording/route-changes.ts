import type { RouteTrackPoint, RouteTrackProjection } from '../types'

export type RouteChangeRecord = {
  ordinal: string; leaseId: string; generation: number; sequence: string
  latitude: number; longitude: number; capturedAt: string; accuracyMeters: number; speedMps: number | null
  visible: boolean; continuesPrevious: boolean
}
export type RouteChangePage = {
  schemaVersion: 1; raidId: string; epoch: string; reset: boolean; cursor: string
  hasMore: boolean; serverAt: string; records: RouteChangeRecord[]
}
const decimal = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value)
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export class RouteChangeBuffer {
  epoch: string | null = null
  cursor = '0'
  private records = new Map<string, RouteChangeRecord>()
  clear() { this.records.clear(); this.epoch = null; this.cursor = '0' }
  accept(page: RouteChangePage, raidId: string): RouteTrackProjection {
    if (!page || page.schemaVersion !== 1 || page.raidId !== raidId || !/^[a-f0-9]{64}$/.test(page.epoch) ||
      !decimal(page.cursor) || typeof page.reset !== 'boolean' || typeof page.hasMore !== 'boolean' ||
      !Number.isFinite(Date.parse(page.serverAt)) || !Array.isArray(page.records) || page.records.length > 300) {
      throw new TypeError('Invalid route page')
    }
    if (!page.reset && (this.epoch !== page.epoch || BigInt(page.cursor) < BigInt(this.cursor))) throw new TypeError('Stale route page')
    if (page.hasMore && !page.reset && page.cursor === this.cursor) throw new TypeError('Route cursor did not advance')
    for (const row of page.records) {
      if (!row || !decimal(row.ordinal) || !decimal(row.sequence) || !uuid(row.leaseId) ||
        !Number.isSafeInteger(row.generation) || row.generation < 1 || !finite(row.latitude) || !finite(row.longitude) ||
        row.latitude < 56.7 || row.latitude > 57 || row.longitude < 53 || row.longitude > 53.4 ||
        !finite(row.accuracyMeters) || row.accuracyMeters < 0 || row.accuracyMeters > 10_000 ||
        !(row.speedMps === null || (finite(row.speedMps) && row.speedMps >= 0)) ||
        !Number.isFinite(Date.parse(row.capturedAt)) || typeof row.visible !== 'boolean' || typeof row.continuesPrevious !== 'boolean') {
        throw new TypeError('Invalid route record')
      }
    }
    // Validate the complete page before mutating the buffer. A malformed page
    // must not discard an already displayed route or advance its cursor.
    if (page.reset) this.records.clear()
    this.epoch = page.epoch
    this.cursor = page.cursor
    for (const row of page.records) this.records.set(`${row.leaseId}:${row.sequence}`, row)
    return this.project(page.serverAt, page.hasMore)
  }
  project(serverAt: string, truncated = false): RouteTrackProjection {
    const now = Date.parse(serverAt)
    const rows = [...this.records.values()].sort((a, b) => a.generation - b.generation ||
      (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0))
      .filter(row => row.visible && Date.parse(row.capturedAt) <= now)
    const segments: RouteTrackPoint[][] = []
    let current: RouteTrackPoint[] = []
    let previous: RouteChangeRecord | undefined
    for (const row of rows) {
      if (!previous || !row.continuesPrevious || previous.leaseId !== row.leaseId || BigInt(row.sequence) !== BigInt(previous.sequence) + 1n) {
        current = []; segments.push(current)
      }
      const point = { latitude: row.latitude, longitude: row.longitude, capturedAt: row.capturedAt,
        accuracyMeters: row.accuracyMeters, speedMps: row.speedMps }
      current.push(point)
      previous = row
    }
    return { segments, startPoint: segments[0]?.[0] ?? null, endPoint: current.at(-1) ?? null,
      pointCount: rows.length, truncated, updatedAt: rows.at(-1)?.capturedAt ?? null, serverAt }
  }
}
