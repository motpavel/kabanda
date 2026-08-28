import Dexie from 'dexie'
import { offlineDb } from '../../offline/db'
import type {
  RecorderSessionRecord,
  RecorderClientRecord,
  RecorderWriterLeaseRecord,
  RouteOutboxRecord,
} from '../../offline/types'
import type { RouteBatchResponse } from '../types'
import type {
  CapturedRouteSample,
  ClaimedRouteBatch,
  RecorderContext,
  RecorderLocalStats,
  WriterFence,
} from './types'

export const WRITER_LEASE_TTL_MS = 12_000
export const WRITER_LEASE_RENEW_MS = 4_000
const BATCH_CLAIM_MS = 30_000

function writerKey(identityId: string, raidId: string): string {
  return JSON.stringify([identityId, raidId])
}

function sessionKey(context: RecorderContext): string {
  return JSON.stringify([
    context.identityId,
    context.raidId,
    context.navigatorLeaseId,
    context.leaseGeneration,
  ])
}

function clientKey(identityId: string, raidId: string): string {
  return JSON.stringify([identityId, raidId])
}

export interface RouteLeaseAttempt {
  clientInstanceId: string
  idempotencyKey: string
  fingerprint: string
}

export async function getOrCreateRouteLeaseAttempt(
  identityId: string,
  kabandaId: string,
  raidId: string,
  action: 'acquire' | 'recover',
  expectedVersion: number,
  now = Date.now(),
): Promise<RouteLeaseAttempt | null> {
  return offlineDb.transaction(
    'rw',
    offlineDb.identityContext,
    offlineDb.recorderClients,
    async () => {
      if (!(await activeIdentityMatches(identityId))) return null
      const key = clientKey(identityId, raidId)
      const existing = await offlineDb.recorderClients.get(key)
      const clientInstanceId = existing?.clientInstanceId ?? crypto.randomUUID()
      const fingerprint = JSON.stringify([action, expectedVersion, clientInstanceId])
      const idempotencyKey = existing?.leaseActionFingerprint === fingerprint && existing.leaseActionKey
        ? existing.leaseActionKey
        : crypto.randomUUID()
      const record: RecorderClientRecord = {
        key,
        identityId,
        kabandaId,
        raidId,
        clientInstanceId,
        leaseActionFingerprint: fingerprint,
        leaseActionKey: idempotencyKey,
        updatedAt: new Date(now).toISOString(),
      }
      await offlineDb.recorderClients.put(record)
      return { clientInstanceId, idempotencyKey, fingerprint }
    },
  )
}

export async function completeRouteLeaseAttempt(
  identityId: string,
  raidId: string,
  fingerprint: string,
  now = Date.now(),
): Promise<void> {
  await offlineDb.transaction('rw', offlineDb.identityContext, offlineDb.recorderClients, async () => {
    if (!(await activeIdentityMatches(identityId))) return
    const key = clientKey(identityId, raidId)
    const record = await offlineDb.recorderClients.get(key)
    if (!record || record.leaseActionFingerprint !== fingerprint) return
    await offlineDb.recorderClients.put({
      ...record,
      leaseActionFingerprint: null,
      leaseActionKey: null,
      updatedAt: new Date(now).toISOString(),
    })
  })
}

export async function findRecorderSession(identityId: string, raidId: string) {
  if (!(await activeIdentityMatches(identityId))) return null
  return offlineDb.recorderSessions
    .where('[identityId+raidId+updatedAt]')
    .between([identityId, raidId, Dexie.minKey], [identityId, raidId, Dexie.maxKey], true, true)
    .reverse()
    .first()
}

type LeaseContext = {
  identityId: string
  raidId: string
  navigatorLeaseId: string
  leaseGeneration: number
}

function sameContext(record: LeaseContext, context: LeaseContext): boolean {
  return record.identityId === context.identityId &&
    record.raidId === context.raidId &&
    record.navigatorLeaseId === context.navigatorLeaseId &&
    record.leaseGeneration === context.leaseGeneration
}

async function activeIdentityMatches(identityId: string): Promise<boolean> {
  return (await offlineDb.identityContext.get('active'))?.userId === identityId
}

function fenceMatches(
  record: RecorderWriterLeaseRecord | undefined,
  fence: WriterFence,
  now: number,
): record is RecorderWriterLeaseRecord {
  return Boolean(
    record &&
    sameContext(record, fence) &&
    record.holderTabId === fence.holderTabId &&
    record.writerGeneration === fence.writerGeneration &&
    record.fenceToken === fence.fenceToken &&
    Date.parse(record.expiresAt) > now,
  )
}

function exposeFence(record: RecorderWriterLeaseRecord): WriterFence {
  return { ...record }
}

export async function getOrCreateRecorderSession(
  context: RecorderContext,
  now = Date.now(),
): Promise<RecorderSessionRecord | null> {
  return offlineDb.transaction(
    'rw',
    offlineDb.identityContext,
    offlineDb.recorderClients,
    offlineDb.recorderSessions,
    async () => {
      if (!(await activeIdentityMatches(context.identityId))) return null
      const key = sessionKey(context)
      const existing = await offlineDb.recorderSessions.get(key)
      if (existing) {
        const next = { ...existing, wanted: true, updatedAt: new Date(now).toISOString() }
        await offlineDb.recorderSessions.put(next)
        return next
      }
      const clientRecord = await offlineDb.recorderClients.get(clientKey(context.identityId, context.raidId))
      const clientInstanceId = clientRecord?.clientInstanceId ?? crypto.randomUUID()
      if (!clientRecord) {
        await offlineDb.recorderClients.add({
          key: clientKey(context.identityId, context.raidId),
          identityId: context.identityId,
          kabandaId: context.kabandaId,
          raidId: context.raidId,
          clientInstanceId,
          leaseActionFingerprint: null,
          leaseActionKey: null,
          updatedAt: new Date(now).toISOString(),
        })
      }
      const created: RecorderSessionRecord = {
        key,
        ...context,
        clientInstanceId,
        wanted: true,
        nextSequence: 0,
        lastPersistedSampleAt: null,
        lastLatitude: null,
        lastLongitude: null,
        preliminaryDistanceM: 0,
        updatedAt: new Date(now).toISOString(),
      }
      await offlineDb.recorderSessions.add(created)
      return created
    },
  )
}

export async function setRecorderWanted(
  context: RecorderContext,
  wanted: boolean,
  now = Date.now(),
): Promise<void> {
  await offlineDb.transaction(
    'rw',
    offlineDb.identityContext,
    offlineDb.recorderSessions,
    async () => {
      if (!(await activeIdentityMatches(context.identityId))) return
      const record = await offlineDb.recorderSessions.get(sessionKey(context))
      if (record) await offlineDb.recorderSessions.put({ ...record, wanted, updatedAt: new Date(now).toISOString() })
    },
  )
}

export async function acquireWriterLease(
  context: RecorderContext,
  holderTabId: string,
  now = Date.now(),
): Promise<WriterFence | null> {
  return offlineDb.transaction(
    'rw',
    offlineDb.identityContext,
    offlineDb.recorderWriterLeases,
    async () => {
      if (!(await activeIdentityMatches(context.identityId))) return null
      const key = writerKey(context.identityId, context.raidId)
      const current = await offlineDb.recorderWriterLeases.get(key)
      const currentActive = current && Date.parse(current.expiresAt) > now
      const sameHolderAndLease = current &&
        current.holderTabId === holderTabId &&
        sameContext(current, context)
      if (currentActive && !sameHolderAndLease && sameContext(current, context)) return null

      const acquired: RecorderWriterLeaseRecord = {
        key,
        ...context,
        holderTabId,
        writerGeneration: (current?.writerGeneration ?? 0) + 1,
        fenceToken: crypto.randomUUID(),
        expiresAt: new Date(now + WRITER_LEASE_TTL_MS).toISOString(),
        updatedAt: new Date(now).toISOString(),
      }
      await offlineDb.recorderWriterLeases.put(acquired)
      return exposeFence(acquired)
    },
  )
}

export async function renewWriterLease(
  fence: WriterFence,
  now = Date.now(),
): Promise<WriterFence | null> {
  return offlineDb.transaction(
    'rw',
    offlineDb.identityContext,
    offlineDb.recorderWriterLeases,
    async () => {
      if (!(await activeIdentityMatches(fence.identityId))) return null
      const record = await offlineDb.recorderWriterLeases.get(fence.key)
      if (!fenceMatches(record, fence, now)) return null
      const renewed = {
        ...record,
        expiresAt: new Date(now + WRITER_LEASE_TTL_MS).toISOString(),
        updatedAt: new Date(now).toISOString(),
      }
      await offlineDb.recorderWriterLeases.put(renewed)
      return exposeFence(renewed)
    },
  )
}

export async function releaseWriterLease(
  fence: WriterFence,
  now = Date.now(),
): Promise<void> {
  await offlineDb.transaction('rw', offlineDb.recorderWriterLeases, async () => {
    const record = await offlineDb.recorderWriterLeases.get(fence.key)
    if (!record ||
      record.holderTabId !== fence.holderTabId ||
      record.writerGeneration !== fence.writerGeneration ||
      record.fenceToken !== fence.fenceToken) return
    await offlineDb.recorderWriterLeases.put({
      ...record,
      expiresAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    })
  })
}

export function distanceMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const radians = Math.PI / 180
  const lat1 = from.latitude * radians
  const lat2 = to.latitude * radians
  const deltaLat = (to.latitude - from.latitude) * radians
  const deltaLng = (to.longitude - from.longitude) * radians
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export async function persistRouteSample(
  context: RecorderContext,
  fence: WriterFence,
  sample: CapturedRouteSample,
  now = Date.now(),
): Promise<RouteOutboxRecord | null> {
  if (![sample.latitude, sample.longitude, sample.accuracyM].every(Number.isFinite)) return null
  return offlineDb.transaction(
    'rw',
    offlineDb.identityContext,
    offlineDb.recorderWriterLeases,
    offlineDb.recorderSessions,
    offlineDb.routeOutbox,
    async () => {
      if (!(await activeIdentityMatches(context.identityId))) return null
      const writer = await offlineDb.recorderWriterLeases.get(fence.key)
      if (!fenceMatches(writer, fence, now) || !sameContext(fence, context)) return null
      const session = await offlineDb.recorderSessions.get(sessionKey(context))
      if (!session || !sameContext(session, context) || !session.wanted) return null
      const sequence = session.nextSequence + 1
      const id = crypto.randomUUID()
      const record: RouteOutboxRecord = {
        id,
        ...context,
        clientInstanceId: session.clientInstanceId,
        sequence,
        ...sample,
        status: 'pending',
        batchId: null,
        attempts: 0,
        nextAttemptAt: null,
        claimUntil: null,
      }
      const addedDistance = session.lastLatitude === null || session.lastLongitude === null
        ? 0
        : distanceMeters(
            { latitude: session.lastLatitude, longitude: session.lastLongitude },
            sample,
          )
      await offlineDb.routeOutbox.add(record)
      await offlineDb.recorderSessions.put({
        ...session,
        nextSequence: sequence,
        lastPersistedSampleAt: sample.capturedAt,
        lastLatitude: sample.latitude,
        lastLongitude: sample.longitude,
        preliminaryDistanceM: session.preliminaryDistanceM + addedDistance,
        updatedAt: new Date(now).toISOString(),
      })
      return record
    },
  )
}

async function rowsForStatus(
  context: RecorderContext,
  status: RouteOutboxRecord['status'],
): Promise<RouteOutboxRecord[]> {
  return offlineDb.routeOutbox
    .where('[identityId+raidId+navigatorLeaseId+status+sequence]')
    .between(
      [context.identityId, context.raidId, context.navigatorLeaseId, status, Dexie.minKey],
      [context.identityId, context.raidId, context.navigatorLeaseId, status, Dexie.maxKey],
      true,
      true,
    )
    .filter((row) => row.leaseGeneration === context.leaseGeneration)
    .sortBy('sequence')
}

export async function claimRouteBatch(
  context: RecorderContext,
  fence: WriterFence,
  now = Date.now(),
  limit = 50,
): Promise<ClaimedRouteBatch | null> {
  const boundedLimit = Math.max(1, Math.min(50, limit))
  return offlineDb.transaction(
    'rw',
    offlineDb.identityContext,
    offlineDb.recorderWriterLeases,
    offlineDb.recorderSessions,
    offlineDb.routeOutbox,
    async () => {
      if (!(await activeIdentityMatches(context.identityId))) return null
      const writer = await offlineDb.recorderWriterLeases.get(fence.key)
      if (!fenceMatches(writer, fence, now) || !sameContext(fence, context)) return null

      const sending = await rowsForStatus(context, 'sending')
      const expired = sending.filter((row) => row.claimUntil && Date.parse(row.claimUntil) <= now)
      if (expired.length) {
        await offlineDb.routeOutbox.bulkPut(expired.map((row) => ({ ...row, status: 'retryable' as const })))
      }

      const retryable = (await rowsForStatus(context, 'retryable'))
        .filter((row) => !row.nextAttemptAt || Date.parse(row.nextAttemptAt) <= now)
      const retryBatchId = retryable.find(({ batchId }) => batchId)?.batchId ?? null
      let rows = retryBatchId
        ? retryable.filter(({ batchId }) => batchId === retryBatchId)
        : (await rowsForStatus(context, 'pending')).filter(({ batchId }) => batchId === null).slice(0, boundedLimit)
      if (!rows.length) return null
      if (rows.length > 50) rows = rows.slice(0, 50)
      const batchId = retryBatchId ?? crypto.randomUUID()
      const claimUntil = new Date(now + BATCH_CLAIM_MS).toISOString()
      const claimed = rows.map((row) => ({
        ...row,
        batchId,
        status: 'sending' as const,
        attempts: row.attempts + 1,
        claimUntil,
        nextAttemptAt: null,
      }))
      await offlineDb.routeOutbox.bulkPut(claimed)
      const session = await offlineDb.recorderSessions.get(sessionKey(context))
      if (!session) return null
      return { batchId, context, clientInstanceId: session.clientInstanceId, rows: claimed }
    },
  )
}

function retryDelayMs(attempts: number): number {
  return [2_000, 5_000, 15_000, 30_000, 60_000][Math.min(Math.max(attempts - 1, 0), 4)] ?? 60_000
}

export async function markRouteBatchRetryable(
  context: RecorderContext,
  fence: WriterFence,
  batchId: string,
  errorCode: string,
  now = Date.now(),
): Promise<boolean> {
  return offlineDb.transaction(
    'rw',
    offlineDb.identityContext,
    offlineDb.recorderWriterLeases,
    offlineDb.routeOutbox,
    async () => {
      if (!(await activeIdentityMatches(context.identityId))) return false
      const writer = await offlineDb.recorderWriterLeases.get(fence.key)
      if (!fenceMatches(writer, fence, now)) return false
      const rows = (await offlineDb.routeOutbox.where('batchId').equals(batchId).toArray())
        .filter((row) => sameContext(row, context) && row.status === 'sending')
      if (!rows.length) return false
      await offlineDb.routeOutbox.bulkPut(rows.map((row) => ({
        ...row,
        status: 'retryable' as const,
        claimUntil: null,
        nextAttemptAt: new Date(now + retryDelayMs(row.attempts)).toISOString(),
        lastErrorCode: errorCode,
      })))
      return true
    },
  )
}

export async function settleRouteBatch(
  context: RecorderContext,
  fence: WriterFence,
  expectedBatchId: string,
  response: RouteBatchResponse,
  now = Date.now(),
): Promise<boolean> {
  if (response.batchId !== expectedBatchId) return false
  return offlineDb.transaction(
    'rw',
    offlineDb.identityContext,
    offlineDb.recorderWriterLeases,
    offlineDb.routeOutbox,
    async () => {
      if (!(await activeIdentityMatches(context.identityId))) return false
      const writer = await offlineDb.recorderWriterLeases.get(fence.key)
      if (!fenceMatches(writer, fence, now)) return false
      const rows = (await offlineDb.routeOutbox.where('batchId').equals(expectedBatchId).toArray())
        .filter((row) => sameContext(row, context) && row.status === 'sending')
      const accepted = new Map(response.accepted.map((item) => [item.operationId, item.acceptedAt]))
      const duplicates = new Set(response.duplicates.map((item) => item.operationId))
      const rejected = new Map(response.rejected.map((item) => [item.operationId, item.code]))
      const classified = new Set([...accepted.keys(), ...duplicates, ...rejected.keys()])
      if (!rows.length || rows.some(({ id }) => !classified.has(id)) || classified.size !== rows.length) return false
      await offlineDb.routeOutbox.bulkPut(rows.map((row) => {
        const rejection = rejected.get(row.id)
        if (rejection) return {
          ...row,
          status: 'rejected' as const,
          claimUntil: null,
          lastErrorCode: rejection,
        }
        return {
          ...row,
          status: 'accepted' as const,
          claimUntil: null,
          acceptedAt: accepted.get(row.id) ?? response.serverAt,
          lastErrorCode: undefined,
        }
      }))
      return true
    },
  )
}

export async function terminalizeRouteLease(
  context: RecorderContext,
  fence: WriterFence,
  errorCode: string,
  rejectOpen: boolean,
  now = Date.now(),
): Promise<void> {
  await offlineDb.transaction(
    'rw',
    offlineDb.identityContext,
    offlineDb.recorderWriterLeases,
    offlineDb.recorderSessions,
    offlineDb.routeOutbox,
    async () => {
      if (!(await activeIdentityMatches(context.identityId))) return
      const writer = await offlineDb.recorderWriterLeases.get(fence.key)
      if (!fenceMatches(writer, fence, now) || !sameContext(fence, context)) return
      const session = await offlineDb.recorderSessions.get(sessionKey(context))
      if (session) await offlineDb.recorderSessions.put({ ...session, wanted: false, updatedAt: new Date(now).toISOString() })
      const rows = [
        ...(await rowsForStatus(context, 'pending')),
        ...(await rowsForStatus(context, 'sending')),
        ...(await rowsForStatus(context, 'retryable')),
      ]
      await offlineDb.routeOutbox.bulkPut(rows.map((row) => ({
        ...row,
        status: rejectOpen
          ? 'rejected' as const
          : row.status === 'sending' ? 'retryable' as const : row.status,
        claimUntil: null,
        lastErrorCode: errorCode,
      })))
    },
  )
}

export async function getRecorderLocalStats(
  context: RecorderContext,
): Promise<RecorderLocalStats> {
  if (!(await activeIdentityMatches(context.identityId))) {
    return { pendingCount: 0, preliminaryDistanceM: 0, lastPersistedSampleAt: null }
  }
  const session = await offlineDb.recorderSessions.get(sessionKey(context))
  if (!session) return { pendingCount: 0, preliminaryDistanceM: 0, lastPersistedSampleAt: null }
  const rows = [
    ...(await rowsForStatus(context, 'pending')),
    ...(await rowsForStatus(context, 'sending')),
    ...(await rowsForStatus(context, 'retryable')),
  ]
  return {
    pendingCount: rows.length,
    preliminaryDistanceM: session.preliminaryDistanceM,
    lastPersistedSampleAt: session.lastPersistedSampleAt,
  }
}
