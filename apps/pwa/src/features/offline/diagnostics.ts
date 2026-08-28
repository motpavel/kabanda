import type { QueueDiagnosticSnapshot } from '../../lib/diagnostics'
import { offlineDb } from './db'

const routeStatuses = new Set(['pending', 'sending', 'retryable'])
const checkInStatuses = new Set(['pending', 'sending', 'retryable'])
const mediaStatuses = new Set(['local', 'intent', 'uploading', 'retryable'])

function snapshot(
  queue: QueueDiagnosticSnapshot['queue'],
  rows: Array<{ createdAt: string; attempts: number; lastErrorCode?: string | null }>,
): QueueDiagnosticSnapshot {
  const oldest = rows.reduce<string | null>((value, row) => {
    if (!value || Date.parse(row.createdAt) < Date.parse(value)) return row.createdAt
    return value
  }, null)
  const latestFailure = rows
    .filter(({ lastErrorCode }) => Boolean(lastErrorCode))
    .sort((left, right) => right.attempts - left.attempts)[0]
  return {
    queue,
    count: rows.length,
    oldestAt: oldest,
    maxAttempts: rows.reduce((value, row) => Math.max(value, row.attempts), 0),
    lastErrorCode: latestFailure?.lastErrorCode ?? null,
  }
}

export async function readQueueDiagnosticSnapshots(): Promise<QueueDiagnosticSnapshot[]> {
  const identityId = (await offlineDb.identityContext.get('active'))?.userId
  if (!identityId) return []
  const [route, checkIns, media] = await Promise.all([
    offlineDb.routeOutbox.where('identityId').equals(identityId).toArray(),
    offlineDb.checkInOutbox.where('identityId').equals(identityId).toArray(),
    offlineDb.mediaDrafts.where('identityId').equals(identityId).toArray(),
  ])
  return [
    snapshot('route', route
      .filter(({ status }) => routeStatuses.has(status))
      .map((row) => ({ createdAt: row.capturedAt, attempts: row.attempts, lastErrorCode: row.lastErrorCode }))),
    snapshot('checkin', checkIns.filter(({ status }) => checkInStatuses.has(status))),
    snapshot('media', media.filter(({ status }) => mediaStatuses.has(status))),
  ]
}
