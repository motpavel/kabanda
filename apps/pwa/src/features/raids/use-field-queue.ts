import { liveQuery } from 'dexie'
import { useEffect, useState } from 'react'
import { fieldOperations, type FieldOperation } from './field-outbox'
import { fieldPendingStates } from './field-scheduler'
export { nextFieldWake } from './field-scheduler'

/** Screen-local view only. FieldSyncOwner keeps sending across navigation and
 * owns the total used by the PWA update guard. Unmounting a screen must neither
 * stop retries nor reset another raid's unsynchronized-work count. */
export function useFieldQueue(identityId: string, raidId: string, _raidState: string) {
  const [rows, setRows] = useState<FieldOperation[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    setRows([]); setError(false)
    const subscription = liveQuery(() => fieldOperations(identityId, raidId)).subscribe({
      next: value => { if (active) { setRows(value); setError(false) } },
      error: () => { if (active) setError(true) },
    })
    return () => { active = false; subscription.unsubscribe() }
  }, [identityId, raidId])
  return { rows, error, pendingCount: rows.filter(row => fieldPendingStates.has(row.status)).length }
}
