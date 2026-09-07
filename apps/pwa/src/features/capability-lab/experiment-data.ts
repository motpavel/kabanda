import Dexie, { type EntityTable } from 'dexie'

export type ExperimentMode = 'watch' | 'poll' | 'combined'
export type Visibility = DocumentVisibilityState | 'worker'
export interface ExperimentRun {
  id: string
  startedAt: number
  endedAt?: number
  mode: ExperimentMode
  keepScreen: boolean
  displayMode: string
  userAgent: string
  version: string
  persisted: boolean | null
}
export interface ExperimentEvent {
  id: string
  runId: string
  kind: string
  receivedAt: number
  monotonicAt: number
  visibility: Visibility
  committedAt?: number
  persistedVisibility?: Visibility
  source?: string
  capturedAt?: number
  latitude?: number
  longitude?: number
  accuracy?: number
  detail?: string
}

export const EXPERIMENT_DB = 'kabanda-gps-experiments-v2'
export const LIMIT_MS = 15 * 60_000
export class ExperimentDatabase extends Dexie {
  runs!: EntityTable<ExperimentRun, 'id'>
  events!: EntityTable<ExperimentEvent, 'id'>
  constructor() {
    super(EXPERIMENT_DB)
    this.version(1).stores({ runs: 'id, startedAt', events: 'id, runId, receivedAt' })
  }
}
export const experimentDb = new ExperimentDatabase()

export function summarizeExperiment(events: ExperimentEvent[], endedAt: number) {
  const ordered = [...events].sort((a, b) => a.receivedAt - b.receivedAt)
  const intervals: { start: number; end: number; open: boolean }[] = []
  let hiddenAt: number | null = null
  for (const event of ordered) {
    if (event.kind === 'visibility.hidden' && hiddenAt === null) hiddenAt = event.receivedAt
    if (event.kind === 'visibility.visible' && hiddenAt !== null) {
      intervals.push({ start: hiddenAt, end: event.receivedAt, open: false })
      hiddenAt = null
    }
  }
  if (hiddenAt !== null) intervals.push({ start: hiddenAt, end: endedAt, open: true })
  const fixes = ordered.filter(event => event.kind === 'gps.fix')
  // Duplicate callbacks and cached positions must not count as independent fresh fixes.
  const unique = new Map<string, ExperimentEvent>()
  for (const fix of fixes) {
    const key = `${fix.capturedAt}:${fix.latitude}:${fix.longitude}`
    if (!unique.has(key)) unique.set(key, fix)
  }
  const freshHidden = [...unique.values()].filter(fix => fix.visibility === 'hidden' &&
    Number.isFinite(fix.capturedAt) && fix.receivedAt - fix.capturedAt! >= -2_000 &&
    fix.receivedAt - fix.capturedAt! <= 15_000 && intervals.some(interval =>
      fix.receivedAt >= interval.start && fix.receivedAt < interval.end &&
      fix.capturedAt! >= interval.start && fix.capturedAt! < interval.end))
  const delayed = fixes.filter(fix => fix.visibility === 'visible' &&
    intervals.some(interval => fix.capturedAt !== undefined && fix.capturedAt >= interval.start &&
      fix.capturedAt < interval.end && fix.receivedAt >= interval.end))
  return {
    fixCount: fixes.length,
    uniqueFixCount: unique.size,
    hiddenCallbacks: fixes.filter(fix => fix.visibility === 'hidden').length,
    freshHiddenFixes: freshHidden.length,
    hiddenStorageWrites: fixes.filter(fix => fix.visibility === 'hidden' && fix.persistedVisibility === 'hidden' && fix.committedAt !== undefined).length,
    delayedFixes: delayed.length,
    pageHiddenTicks: ordered.filter(event => event.kind === 'page.tick' && event.visibility === 'hidden').length,
    workerHiddenTicks: ordered.filter(event => event.kind === 'worker.tick' && intervals.some(interval =>
      event.receivedAt >= interval.start && event.receivedAt < interval.end &&
      event.committedAt !== undefined && event.committedAt >= interval.start && event.committedAt < interval.end)).length,
    errors: ordered.filter(event => event.kind === 'gps.error').length,
    intervals,
    hiddenDurationMs: intervals.reduce((total, interval) => total + Math.max(0, interval.end - interval.start), 0),
    lastFix: fixes.at(-1) ?? null,
    // A stationary run with no hidden fixes is inconclusive; never claim GPS is impossible.
    result: intervals.length === 0 ? 'no-hidden-period' : freshHidden.length > 0 ? 'hidden-fixes-observed' : 'not-demonstrated',
  }
}
