import type { FieldOperation } from './field-outbox'

export type FieldLane = 'team' | 'materials'
export type FieldWork = Pick<FieldOperation, 'operationId' | 'raidId' | 'kind' | 'status' | 'createdAt' | 'nextAttemptAt' | 'claimUntil'>
export const fieldPendingStates = new Set<FieldOperation['status']>(['pending', 'sending', 'retryable'])
const deadline = (row: FieldWork) => Math.max(row.nextAttemptAt, row.status === 'sending' ? row.claimUntil : 0)
export function nextFieldWake(rows: readonly FieldWork[], now: number): number | null {
  const deadlines = rows.filter(row => fieldPendingStates.has(row.status)).map(deadline)
  return deadlines.length ? Math.max(250, Math.min(...deadlines) - now) : null
}

type LaneState = { busy: boolean; notified: boolean; timer?: ReturnType<typeof setTimeout> }
type Dependencies = {
  read: () => Promise<readonly FieldWork[]>
  pump: (raidId: string, lane: FieldLane) => Promise<void>
  available: () => boolean
  onError?: (failed: boolean) => void
  now?: () => number
}

/** One app-scoped owner, two independent clocks. A slow photo cannot postpone a
 * team retry. Durable operation claims remain the authority between tabs.
 * Stopping this owner only stops scheduling; submitted writes are never aborted. */
export class FieldSyncScheduler {
  private stopped = false
  private readonly lanes: Record<FieldLane, LaneState> = {
    team: { busy: false, notified: false }, materials: { busy: false, notified: false },
  }
  private readonly failed = new Set<FieldLane>()
  private readonly now: () => number
  constructor(private readonly dependencies: Dependencies) { this.now = dependencies.now ?? Date.now }

  wake = () => {
    for (const lane of ['team', 'materials'] as const) {
      const state = this.lanes[lane]
      clearTimeout(state.timer); state.timer = undefined
      if (this.stopped || !this.dependencies.available()) continue
      if (state.busy) { state.notified = true; continue }
      void this.run(lane)
    }
  }
  stop() {
    this.stopped = true
    for (const state of Object.values(this.lanes)) { clearTimeout(state.timer); state.timer = undefined }
  }
  private eligible(rows: readonly FieldWork[], lane: FieldLane) {
    return rows.filter(row => fieldPendingStates.has(row.status) && (lane === 'team' ? row.kind === 'team' : row.kind !== 'team'))
  }
  private async run(lane: FieldLane) {
    const state = this.lanes[lane]
    if (this.stopped || state.busy || !this.dependencies.available()) return
    state.busy = true; state.notified = false
    let wait: number | null = null
    let failed = false
    try {
      let rows = this.eligible(await this.dependencies.read(), lane)
      if (this.stopped || !this.dependencies.available()) return
      // Among ready operations use arrival order, not raid ID, so another raid's
      // already-due visit is not held behind a sleeping retry in the first raid.
      const due = rows.filter(row => deadline(row) <= this.now()).sort((a, b) => a.createdAt - b.createdAt)[0]
      if (due) {
        await this.dependencies.pump(due.raidId, lane)
        if (this.stopped || !this.dependencies.available()) return
        rows = this.eligible(await this.dependencies.read(), lane)
      }
      wait = nextFieldWake(rows, this.now())
      this.failed.delete(lane)
    } catch {
      failed = true; wait = 2000; this.failed.add(lane)
    } finally {
      state.busy = false
      if (!this.stopped) this.dependencies.onError?.(this.failed.size > 0)
      if (!this.stopped && this.dependencies.available()) {
        // A notification received during a read can introduce another due row.
        // Never spin on a failed local store, even if it produces notifications.
        if (state.notified && !failed) wait = wait === null ? 250 : Math.min(250, wait)
        if (wait !== null) state.timer = setTimeout(() => { state.timer = undefined; void this.run(lane) }, Math.min(wait, 30_000))
      }
    }
  }
}
