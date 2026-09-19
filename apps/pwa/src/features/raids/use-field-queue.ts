import { liveQuery } from 'dexie'
import { useEffect, useState } from 'react'
import { fieldOperations, pumpFieldOperations, type FieldOperation } from './field-outbox'
import { useRecordingRuntime } from './recording/runtime'

const pending = new Set<FieldOperation['status']>(['pending', 'sending', 'retryable'])
export function nextFieldWake(rows: readonly FieldOperation[], now: number): number | null {
  const deadlines = rows.filter(row => pending.has(row.status)).map(row =>
    Math.max(row.nextAttemptAt, row.status === 'sending' ? row.claimUntil : 0))
  return deadlines.length ? Math.max(250, Math.min(...deadlines) - now) : null
}

/** Timers wake from persisted deadlines, not from an unrelated user click.
 * Multiple mounted consumers are safe: the sender also has a per-lane flight
 * and atomic durable claim. Unmounting never cancels a submitted write. */
export function useFieldQueue(identityId: string, raidId: string, raidState: string) {
  const [rows, setRows] = useState<FieldOperation[]>([])
  const [error, setError] = useState(false)
  const { setUnsyncedFieldWork } = useRecordingRuntime()
  useEffect(() => {
    let active = true
    setRows([])
    setError(false)
    const subscription = liveQuery(() => fieldOperations(identityId, raidId)).subscribe({
      next: value => { if (active) { setRows(value); setError(false) } },
      error: () => { if (active) setError(true) },
    })
    return () => { active = false; subscription.unsubscribe(); setUnsyncedFieldWork(0) }
  }, [identityId, raidId, setUnsyncedFieldWork])
  useEffect(() => {
    // A storage error is unknown work, not evidence of an empty queue.
    setUnsyncedFieldWork(error ? 1 : rows.filter(row => pending.has(row.status)).length)
  }, [rows, error, setUnsyncedFieldWork])
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const runnable = rows.filter(row => row.kind !== 'team' || raidState === 'active')
    const schedule = () => {
      clearTimeout(timer)
      const wait = nextFieldWake(runnable, Date.now())
      if (active && wait !== null) timer = setTimeout(run, Math.min(wait, 30_000))
    }
    const run = () => {
      if (!active) return
      if (document.visibilityState !== 'visible' || !navigator.onLine) { schedule(); return }
      const tasks: Promise<void>[] = []
      if (raidState === 'active') tasks.push(pumpFieldOperations(identityId, raidId, 'team'))
      if (['active', 'paused', 'finalizing', 'completed'].includes(raidState)) {
        tasks.push(pumpFieldOperations(identityId, raidId, 'materials'))
      }
      void Promise.all(tasks).catch(() => { if (active) setError(true) }).finally(schedule)
    }
    run()
    window.addEventListener('online', run)
    window.addEventListener('focus', run)
    window.addEventListener('pageshow', run)
    document.addEventListener('visibilitychange', run)
    return () => {
      active = false
      clearTimeout(timer)
      window.removeEventListener('online', run)
      window.removeEventListener('focus', run)
      window.removeEventListener('pageshow', run)
      document.removeEventListener('visibilitychange', run)
    }
  }, [identityId, raidId, raidState, rows])
  return { rows, error, pendingCount: rows.filter(row => pending.has(row.status)).length }
}
