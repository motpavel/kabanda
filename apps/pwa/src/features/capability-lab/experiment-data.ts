import Dexie, { type EntityTable } from 'dexie'

export type ExperimentMode = 'watch' | 'poll' | 'combined' | 'audio'
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
  // A callback is not evidence of persistence until its first IndexedDB write
  // completes inside the same hidden period. Acknowledgement after resume fails.
  const hiddenWriteInterval = (event: ExperimentEvent) => event.visibility === 'hidden' &&
    event.persistedVisibility === 'hidden' && event.committedAt !== undefined &&
    event.committedAt >= event.receivedAt
    ? intervals.find(interval => event.receivedAt >= interval.start && event.receivedAt < interval.end &&
      event.committedAt! >= interval.start && event.committedAt! < interval.end)
    : undefined
  const confirmedHidden = freshHidden.filter(fix => {
    const interval = hiddenWriteInterval(fix)
    return interval !== undefined && fix.capturedAt! >= interval.start && fix.capturedAt! < interval.end
  })
  // Exclude the short execution grace period immediately after hiding. This
  // remains a count of observed fixes, not proof of uninterrupted GPS tracking.
  const sustainedHidden = confirmedHidden.filter(fix => {
    const interval = hiddenWriteInterval(fix)!
    const interiorStart = interval.start + 60_000
    return fix.capturedAt! >= interiorStart && fix.receivedAt >= interiorStart && fix.committedAt! >= interiorStart
  })
  const delayed = fixes.filter(fix => fix.visibility === 'visible' &&
    intervals.some(interval => fix.capturedAt !== undefined && fix.capturedAt >= interval.start &&
      fix.capturedAt < interval.end && fix.receivedAt >= interval.end))
  return {
    fixCount: fixes.length,
    uniqueFixCount: unique.size,
    hiddenCallbacks: fixes.filter(fix => fix.visibility === 'hidden').length,
    freshHiddenFixes: freshHidden.length,
    confirmedHiddenFixes: confirmedHidden.length,
    sustainedHiddenFixes: sustainedHidden.length,
    hiddenStorageWrites: fixes.filter(fix => fix.visibility === 'hidden' && fix.persistedVisibility === 'hidden' && fix.committedAt !== undefined).length,
    delayedFixes: delayed.length,
    pageHiddenTicks: ordered.filter(event => event.kind === 'page.tick' && event.visibility === 'hidden').length,
    pageHiddenWrites: ordered.filter(event => event.kind === 'page.tick' && hiddenWriteInterval(event)).length,
    // Media callbacks only demonstrate page execution; they never count as GPS
    // evidence or prove that audio kept playing throughout the hidden period.
    audioHiddenEvents: ordered.filter(event => event.kind === 'audio.timeupdate' && hiddenWriteInterval(event)).length,
    audioErrors: ordered.filter(event => event.kind === 'audio.error').length,
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
