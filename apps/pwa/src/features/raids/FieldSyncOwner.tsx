import { liveQuery } from 'dexie'
import { useEffect, useState } from 'react'
import { getCurrentUser } from '../auth/api'
import { getActiveIdentityId, IDENTITY_CHANGED_EVENT } from '../offline/ledger'
import { fieldDb, pumpFieldOperations } from './field-outbox'
import { FieldSyncScheduler, fieldPendingStates, type FieldWork } from './field-scheduler'
import { useRecordingRuntime } from './recording/runtime'

/** Do not load accepted photo blobs to calculate wakeups. No stored operation,
 * payload or image is deleted by the scheduler, including already uploaded ones. */
export async function pendingFieldWork(identityId: string): Promise<FieldWork[]> {
  if (await getActiveIdentityId() !== identityId) return []
  const rows: FieldWork[] = []
  await fieldDb.operations.where('status').anyOf([...fieldPendingStates]).each(row => {
    if (row.identityId !== identityId) return
    const { operationId, raidId, kind, status, createdAt, nextAttemptAt, claimUntil } = row
    rows.push({ operationId, raidId, kind, status, createdAt, nextAttemptAt, claimUntil })
  })
  return await getActiveIdentityId() === identityId ? rows : []
}

/** Mounted next to AppRoute, not inside one raid. A persisted identity alone
 * does not authorize replay: start after the existing verified-session API. */
export function FieldSyncOwner() {
  const [identityId, setIdentityId] = useState<string | null>(null)
  const { setUnsyncedFieldWork } = useRecordingRuntime()
  useEffect(() => {
    let active = true, generation = 0
    const changed = (event: Event) => {
      generation++
      const id = (event as CustomEvent<{ userId: string | null }>).detail.userId
      if (active) setIdentityId(id)
    }
    const storage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== 'kabanda:relay-session:v1') return
      generation++; setIdentityId(null)
      // Session consumers reverify and announce the new identity. A stored
      // token (even for the same user) is not proof of a live authorization.
    }
    window.addEventListener(IDENTITY_CHANGED_EVENT, changed)
    window.addEventListener('storage', storage)
    const token = generation
    void getCurrentUser().then(user => {
      if (active && generation === token) setIdentityId(user.id)
    }).catch(() => { /* Existing auth screens own retry and login feedback. */ })
    return () => {
      active = false; generation++
      window.removeEventListener(IDENTITY_CHANGED_EVENT, changed)
      window.removeEventListener('storage', storage)
    }
  }, [])
  useEffect(() => {
    setUnsyncedFieldWork(0)
    if (!identityId) return
    let active = true, count = 0, storeFailed = false, senderFailed = false
    const publish = () => { if (active) setUnsyncedFieldWork(Math.max(count, storeFailed || senderFailed ? 1 : 0)) }
    const scheduler = new FieldSyncScheduler({
      read: () => pendingFieldWork(identityId),
      pump: (raidId, lane) => pumpFieldOperations(identityId, raidId, lane),
      available: () => active && document.visibilityState === 'visible' && navigator.onLine,
      onError: failed => { senderFailed = failed; publish() },
    })
    const subscription = liveQuery(() => pendingFieldWork(identityId)).subscribe({
      next: rows => { if (active) { count = rows.length; storeFailed = false; publish(); scheduler.wake() } },
      error: () => { if (active) { storeFailed = true; publish(); scheduler.wake() } },
    })
    const wake = () => scheduler.wake()
    for (const event of ['online', 'offline', 'focus', 'pageshow']) window.addEventListener(event, wake)
    document.addEventListener('visibilitychange', wake)
    scheduler.wake()
    return () => {
      active = false; scheduler.stop(); subscription.unsubscribe(); setUnsyncedFieldWork(0)
      for (const event of ['online', 'offline', 'focus', 'pageshow']) window.removeEventListener(event, wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [identityId, setUnsyncedFieldWork])
  return null
}
