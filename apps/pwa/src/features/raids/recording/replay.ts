import { ApiError } from '../../../lib/http'
import type { RouteOutboxRecord } from '../../offline/types'
import { sendRouteBatch } from '../api'
import type { RouteBatchInput, RouteStatusProjection } from '../types'
import {
  claimRouteBatch,
  markRouteBatchRetryable,
  settleRouteBatch,
  terminalizeRouteLease,
} from './store'
import type { RecorderContext, WriterFence } from './types'

export type ReplayResult =
  | { kind: 'idle' }
  | { kind: 'accepted'; routeStatus: RouteStatusProjection }
  | { kind: 'retryable' }
  | { kind: 'terminal'; code: string; authRequired: boolean }
  | { kind: 'fence-lost' }

function toInput(
  leaseId: string,
  clientInstanceId: string,
  rows: RouteOutboxRecord[],
): RouteBatchInput {
  return {
    schemaVersion: 1,
    leaseId,
    clientInstanceId,
    samples: rows.map((row) => ({
      operationId: row.id,
      sequence: row.sequence,
      capturedAt: row.capturedAt,
      latitude: row.latitude,
      longitude: row.longitude,
      accuracyM: row.accuracyM,
      ...(row.speedMps === null ? {} : { speedMps: row.speedMps }),
      ...(row.headingDeg === null ? {} : { headingDeg: row.headingDeg }),
    })),
  }
}

export async function replayRouteBatch(
  context: RecorderContext,
  fence: WriterFence,
  now = Date.now(),
): Promise<ReplayResult> {
  const batch = await claimRouteBatch(context, fence, now, 50)
  if (!batch) return { kind: 'idle' }
  try {
    const response = await sendRouteBatch(
      context.raidId,
      batch.batchId,
      toInput(context.navigatorLeaseId, batch.clientInstanceId, batch.rows),
    )
    const settled = await settleRouteBatch(context, fence, batch.batchId, response)
    return settled
      ? { kind: 'accepted', routeStatus: response.routeStatus }
      : { kind: 'fence-lost' }
  } catch (error) {
    const terminal = error instanceof ApiError && (
      error.status === 401 ||
      error.status === 403 ||
      error.code === 'NAVIGATOR_LEASE_STALE'
    )
    if (terminal) {
      await terminalizeRouteLease(context, fence, error.code, error.status !== 401 && error.status !== 403)
      return { kind: 'terminal', code: error.code, authRequired: error.status === 401 }
    }
    if (error instanceof ApiError && error.status < 500) {
      await terminalizeRouteLease(context, fence, error.code, true)
      return { kind: 'terminal', code: error.code, authRequired: false }
    }
    const marked = await markRouteBatchRetryable(
      context,
      fence,
      batch.batchId,
      error instanceof ApiError ? error.code : 'NETWORK_ERROR',
    )
    return marked ? { kind: 'retryable' } : { kind: 'fence-lost' }
  }
}
