import { liveQuery } from 'dexie'
import { useEffect, useRef } from 'react'
import { offlineDb } from '../offline/db'
import { getActiveIdentityId } from '../offline/ledger'
import { FieldSyncScheduler, type FieldWork } from '../raids/field-scheduler'

const checks = ['pending', 'sending', 'retryable']
const photos = ['local', 'intent', 'uploading', 'retryable']
const timestamp = (value: string | null, fallback: number) => {
  if (value === null) return fallback
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Only read scheduling metadata. Do not change claims, payload, Blob, retry
 * counters, or manufacture a different operation after a failed file read. */
export async function readLegacyRetryWork(identityId: string, raidId: string): Promise<FieldWork[]> {
  if (await getActiveIdentityId() !== identityId) return []
  const rows: FieldWork[] = []
  const now = Date.now()
  const append = (row: { operationId: string; identityId: string; raidId: string; status: string;
    nextAttemptAt: string | null; claimUntil: string | null; createdAt: string }) => {
    if (row.identityId !== identityId || row.raidId !== raidId) return
    const claimed = row.status === 'sending' || row.status === 'uploading'
    rows.push({ operationId: row.operationId, raidId, kind: 'team',
      status: claimed ? 'sending' : row.status === 'retryable' ? 'retryable' : 'pending',
      createdAt: timestamp(row.createdAt, now),
      nextAttemptAt: timestamp(row.nextAttemptAt, row.nextAttemptAt === null ? 0 : now + 30_000),
      claimUntil: claimed ? timestamp(row.claimUntil, now + 30_000) : 0 })
  }
  await Promise.all([
    offlineDb.checkInOutbox.where('status').anyOf(checks).each(append),
    offlineDb.mediaDrafts.where('status').anyOf(photos).each(append),
  ])
  return await getActiveIdentityId() === identityId ? rows : []
}

/** Compatibility sender for existing installed-client queues. Use its original
 * flush/fences/API authorization, but actually wake when nextAttemptAt arrives.
 * All legacy work stays in one lane because it shares one durable sender lease.
 * New field team/material operations keep their independent app-level lanes. */
export function useLegacyRetry(identityId: string, raidId: string, enabled: boolean,
  sending: boolean, flush: () => Promise<void>) {
  const callback = useRef(flush)
  callback.current = flush
  useEffect(() => {
    if (!enabled || sending) return
    let active = true
    const scheduler = new FieldSyncScheduler({
      read: () => readLegacyRetryWork(identityId, raidId),
      pump: () => callback.current(),
      available: () => active && navigator.onLine && document.visibilityState === 'visible',
    })
    const wake = () => scheduler.wake()
    const subscription = liveQuery(() => readLegacyRetryWork(identityId, raidId))
      .subscribe({ next: wake, error: wake })
    for (const event of ['online', 'offline', 'focus', 'pageshow']) window.addEventListener(event, wake)
    document.addEventListener('visibilitychange', wake)
    scheduler.wake()
    return () => {
      active = false; scheduler.stop(); subscription.unsubscribe()
      for (const event of ['online', 'offline', 'focus', 'pageshow']) window.removeEventListener(event, wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [identityId, raidId, enabled, sending])
}
