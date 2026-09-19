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

/** One owner per raid screen. Durable claims also fence other tabs. Stopping
 * the UI scheduler does not abort a submitted command or alter its payload. */
export function useFieldQueue(identityId: string, raidId: string, raidState: string) {
  const [rows, setRows] = useState<FieldOperation[]>([])
  const [error, setError] = useState(false)
  const { setUnsyncedFieldWork } = useRecordingRuntime()
  useEffect(() => {
    let active = true
    setRows([]); setError(false)
    const subscription = liveQuery(() => fieldOperations(identityId, raidId)).subscribe({
      next: value => { if (active) { setRows(value); setError(false) } },
      error: () => { if (active) setError(true) },
    })
    return () => { active = false; subscription.unsubscribe(); setUnsyncedFieldWork(0) }
  }, [identityId, raidId, setUnsyncedFieldWork])
  useEffect(() => {
    setUnsyncedFieldWork(error ? 1 : rows.filter(row => pending.has(row.status)).length)
  }, [rows, error, setUnsyncedFieldWork])
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const available = ['active', 'paused', 'finalizing', 'completed'].includes(raidState)
    const foreground = () => document.visibilityState === 'visible' && navigator.onLine
    const schedule = () => {
      clearTimeout(timer)
      // Waiting for online/visibility events avoids a 250 ms busy loop when
      // an already due operation is saved while the phone is offline.
      if (!active || !available || !foreground()) return
      const wait = nextFieldWake(rows, Date.now())
      if (wait !== null) timer = setTimeout(run, Math.min(wait, 30_000))
    }
    const run = () => {
      if (!active || !available || !foreground()) { clearTimeout(timer); return }
      // Receipt replay is safe after finish: the server returns the original
      // acknowledgement but refuses creation of a new visit outside active.
      void Promise.all([
        pumpFieldOperations(identityId, raidId, 'team'),
        pumpFieldOperations(identityId, raidId, 'materials'),
      ]).catch(() => { if (active) setError(true) }).finally(schedule)
    }
    run()
    window.addEventListener('online', run)
    window.addEventListener('offline', run)
    window.addEventListener('focus', run)
    window.addEventListener('pageshow', run)
    document.addEventListener('visibilitychange', run)
    return () => {
      active = false; clearTimeout(timer)
      window.removeEventListener('online', run); window.removeEventListener('offline', run)
      window.removeEventListener('focus', run); window.removeEventListener('pageshow', run)
      document.removeEventListener('visibilitychange', run)
    }
  }, [identityId, raidId, raidState, rows])
  return { rows, error, pendingCount: rows.filter(row => pending.has(row.status)).length }
}
