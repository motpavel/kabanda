import { offlineDb } from '../offline/db'
import type {
  CheckInOutboxRecord,
  CheckInSenderLeaseRecord,
  MediaDraftRecord,
} from '../offline/types'
import type {
  CheckInResponse,
  CreateCheckInInput,
  CreateFallbackInput,
  FallbackResponse,
  MediaUploadResponse,
} from './types'

const SENDER_LEASE_MS = 30_000
const CLAIM_MS = 30_000

export interface CheckInSenderFence extends CheckInSenderLeaseRecord {}

function senderKey(identityId: string, raidId: string): string {
  return JSON.stringify([identityId, raidId])
}

async function identityMatches(identityId: string): Promise<boolean> {
  return (await offlineDb.identityContext.get('active'))?.userId === identityId
}

function fenceMatches(
  current: CheckInSenderLeaseRecord | undefined,
  fence: CheckInSenderFence,
  now: number,
): boolean {
  return Boolean(
    current &&
    current.identityId === fence.identityId &&
    current.raidId === fence.raidId &&
    current.holderTabId === fence.holderTabId &&
    current.generation === fence.generation &&
    current.fenceToken === fence.fenceToken &&
    Date.parse(current.expiresAt) > now,
  )
}

export async function enqueueCheckIn(
  identityId: string,
  kabandaId: string,
  raidId: string,
  input: CreateCheckInInput,
  now = Date.now(),
): Promise<CheckInOutboxRecord | null> {
  return offlineDb.transaction('rw', offlineDb.identityContext, offlineDb.checkInOutbox, async () => {
    if (!(await identityMatches(identityId))) return null
    const timestamp = new Date(now).toISOString()
    const record: CheckInOutboxRecord = {
      operationId: crypto.randomUUID(),
      identityId,
      kabandaId,
      raidId,
      ...input,
      status: 'pending',
      attempts: 0,
      claimUntil: null,
      nextAttemptAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastErrorCode: null,
      response: null,
    }
    await offlineDb.checkInOutbox.add(record)
    return record
  })
}

export async function acquireCheckInSenderLease(
  identityId: string,
  raidId: string,
  holderTabId: string,
  now = Date.now(),
): Promise<CheckInSenderFence | null> {
  return offlineDb.transaction('rw', offlineDb.identityContext, offlineDb.checkInSenderLeases, async () => {
    if (!(await identityMatches(identityId))) return null
    const key = senderKey(identityId, raidId)
    const current = await offlineDb.checkInSenderLeases.get(key)
    if (current && Date.parse(current.expiresAt) > now && current.holderTabId !== holderTabId) return null
    const next: CheckInSenderLeaseRecord = {
      key,
      identityId,
      raidId,
      holderTabId,
      generation: (current?.generation ?? 0) + 1,
      fenceToken: crypto.randomUUID(),
      expiresAt: new Date(now + SENDER_LEASE_MS).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }
    await offlineDb.checkInSenderLeases.put(next)
    return next
  })
}

async function assertFence(fence: CheckInSenderFence, now: number): Promise<boolean> {
  if (!(await identityMatches(fence.identityId))) return false
  return fenceMatches(await offlineDb.checkInSenderLeases.get(fence.key), fence, now)
}

export async function claimNextCheckIn(
  fence: CheckInSenderFence,
  now = Date.now(),
): Promise<CheckInOutboxRecord | null> {
  return offlineDb.transaction(
    'rw',
    offlineDb.identityContext,
    offlineDb.checkInSenderLeases,
    offlineDb.checkInOutbox,
    async () => {
      if (!(await assertFence(fence, now))) return null
      const rows = await offlineDb.checkInOutbox
        .where('identityId')
        .equals(fence.identityId)
        .filter((row) => row.raidId === fence.raidId)
        .toArray()
      const candidate = rows
        .filter((row) => row.status === 'pending' || row.status === 'retryable' ||
          (row.status === 'sending' && row.claimUntil !== null && Date.parse(row.claimUntil) <= now))
        .filter((row) => !row.nextAttemptAt || Date.parse(row.nextAttemptAt) <= now)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
      if (!candidate) return null
      const claimed: CheckInOutboxRecord = {
        ...candidate,
        status: 'sending',
        attempts: candidate.attempts + 1,
        claimUntil: new Date(now + CLAIM_MS).toISOString(),
        nextAttemptAt: null,
        updatedAt: new Date(now).toISOString(),
      }
      await offlineDb.checkInOutbox.put(claimed)
      return claimed
    },
  )
}

export async function settleCheckIn(
  fence: CheckInSenderFence,
  operationId: string,
  response: CheckInResponse,
  now = Date.now(),
): Promise<boolean> {
  if (response.operationId !== operationId) return false
  return offlineDb.transaction(
    'rw',
    offlineDb.identityContext,
    offlineDb.checkInSenderLeases,
    offlineDb.checkInOutbox,
    async () => {
      if (!(await assertFence(fence, now))) return false
      const row = await offlineDb.checkInOutbox.get(operationId)
      if (!row || row.identityId !== fence.identityId || row.raidId !== fence.raidId || row.status !== 'sending') return false
      await offlineDb.checkInOutbox.put({
        ...row,
        status: response.outcome === 'accepted' ? 'accepted' : 'needs_action',
        claimUntil: null,
        response,
        lastErrorCode: response.reason,
        updatedAt: new Date(now).toISOString(),
      })
      return true
    },
  )
}

function retryAt(now: number, attempts: number): string {
  const delay = [2_000, 5_000, 15_000, 30_000][Math.min(Math.max(attempts - 1, 0), 3)] ?? 30_000
  return new Date(now + delay).toISOString()
}

export async function retryCheckIn(
  fence: CheckInSenderFence,
  operationId: string,
  code: string,
  terminal: boolean,
  now = Date.now(),
): Promise<boolean> {
  return offlineDb.transaction(
    'rw',
    offlineDb.identityContext,
    offlineDb.checkInSenderLeases,
    offlineDb.checkInOutbox,
    async () => {
      if (!(await assertFence(fence, now))) return false
      const row = await offlineDb.checkInOutbox.get(operationId)
      if (!row || row.status !== 'sending' || row.identityId !== fence.identityId || row.raidId !== fence.raidId) return false
      await offlineDb.checkInOutbox.put({
        ...row,
        status: terminal ? 'rejected' : 'retryable',
        claimUntil: null,
        nextAttemptAt: terminal ? null : retryAt(now, row.attempts),
        lastErrorCode: code,
        updatedAt: new Date(now).toISOString(),
      })
      return true
    },
  )
}

export async function persistMediaDraft(input: Omit<MediaDraftRecord, 'operationId' | 'clientDraftId' | 'status' | 'intentId' | 'mediaId' | 'attempts' | 'claimUntil' | 'nextAttemptAt' | 'createdAt' | 'updatedAt' | 'lastErrorCode'>, now = Date.now()): Promise<MediaDraftRecord | null> {
  return offlineDb.transaction('rw', offlineDb.identityContext, offlineDb.mediaDrafts, async () => {
    if (!(await identityMatches(input.identityId))) return null
    const timestamp = new Date(now).toISOString()
    const record: MediaDraftRecord = {
      operationId: crypto.randomUUID(),
      clientDraftId: crypto.randomUUID(),
      ...input,
      status: 'local',
      intentId: null,
      mediaId: null,
      attempts: 0,
      claimUntil: null,
      nextAttemptAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastErrorCode: null,
    }
    await offlineDb.mediaDrafts.add(record)
    return record
  })
}

export async function replaceExpiredMediaIntent(
  fence: CheckInSenderFence,
  operationId: string,
  now = Date.now(),
): Promise<boolean> {
  return offlineDb.transaction('rw', offlineDb.identityContext, offlineDb.checkInSenderLeases, offlineDb.mediaDrafts, async () => {
    if (!(await assertFence(fence, now))) return false
    const row = await offlineDb.mediaDrafts.get(operationId)
    if (!row || row.status !== 'uploading' || row.identityId !== fence.identityId || row.raidId !== fence.raidId) return false
    const replacement: MediaDraftRecord = {
      ...row,
      operationId: crypto.randomUUID(),
      status: 'retryable',
      intentId: null,
      attempts: 0,
      claimUntil: null,
      nextAttemptAt: null,
      lastErrorCode: 'MEDIA_INTENT_EXPIRED',
      updatedAt: new Date(now).toISOString(),
    }
    await offlineDb.mediaDrafts.put({
      ...row,
      status: 'rejected',
      claimUntil: null,
      lastErrorCode: 'MEDIA_INTENT_EXPIRED',
      updatedAt: new Date(now).toISOString(),
    })
    await offlineDb.mediaDrafts.add(replacement)
    return true
  })
}

export async function claimNextMediaDraft(
  fence: CheckInSenderFence,
  now = Date.now(),
): Promise<MediaDraftRecord | null> {
  return offlineDb.transaction(
    'rw',
    offlineDb.identityContext,
    offlineDb.checkInSenderLeases,
    offlineDb.mediaDrafts,
    async () => {
      if (!(await assertFence(fence, now))) return null
      const rows = await offlineDb.mediaDrafts
        .where('identityId')
        .equals(fence.identityId)
        .filter((row) => row.raidId === fence.raidId)
        .toArray()
      const candidate = rows
        .filter((row) => row.status === 'local' || row.status === 'intent' || row.status === 'retryable' ||
          (row.status === 'uploading' && row.claimUntil !== null && Date.parse(row.claimUntil) <= now))
        .filter((row) => !row.nextAttemptAt || Date.parse(row.nextAttemptAt) <= now)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
      if (!candidate) return null
      const next = {
        ...candidate,
        status: 'uploading' as const,
        attempts: candidate.attempts + 1,
        claimUntil: new Date(now + CLAIM_MS).toISOString(),
        nextAttemptAt: null,
        updatedAt: new Date(now).toISOString(),
      }
      await offlineDb.mediaDrafts.put(next)
      return next
    },
  )
}

export async function rememberMediaIntent(
  fence: CheckInSenderFence,
  operationId: string,
  intentId: string,
  now = Date.now(),
): Promise<boolean> {
  return offlineDb.transaction('rw', offlineDb.identityContext, offlineDb.checkInSenderLeases, offlineDb.mediaDrafts, async () => {
    if (!(await assertFence(fence, now))) return false
    const row = await offlineDb.mediaDrafts.get(operationId)
    if (!row || row.status !== 'uploading' || row.identityId !== fence.identityId || row.raidId !== fence.raidId) return false
    await offlineDb.mediaDrafts.put({ ...row, intentId, updatedAt: new Date(now).toISOString() })
    return true
  })
}

export async function settleMediaDraft(
  fence: CheckInSenderFence,
  operationId: string,
  response: MediaUploadResponse,
  now = Date.now(),
): Promise<boolean> {
  return offlineDb.transaction('rw', offlineDb.identityContext, offlineDb.checkInSenderLeases, offlineDb.mediaDrafts, async () => {
    if (!(await assertFence(fence, now))) return false
    const row = await offlineDb.mediaDrafts.get(operationId)
    if (!row || row.status !== 'uploading' || row.identityId !== fence.identityId || row.raidId !== fence.raidId) return false
    await offlineDb.mediaDrafts.put({
      ...row,
      blob: new Blob([], { type: row.contentType }),
      status: 'accepted',
      mediaId: response.media.id,
      claimUntil: null,
      lastErrorCode: null,
      updatedAt: new Date(now).toISOString(),
    })
    return true
  })
}

export async function retryMediaDraft(
  fence: CheckInSenderFence,
  operationId: string,
  code: string,
  terminal: boolean,
  now = Date.now(),
): Promise<boolean> {
  return offlineDb.transaction('rw', offlineDb.identityContext, offlineDb.checkInSenderLeases, offlineDb.mediaDrafts, async () => {
    if (!(await assertFence(fence, now))) return false
    const row = await offlineDb.mediaDrafts.get(operationId)
    if (!row || row.status !== 'uploading' || row.identityId !== fence.identityId || row.raidId !== fence.raidId) return false
    await offlineDb.mediaDrafts.put({
      ...row,
      status: terminal ? 'rejected' : 'retryable',
      claimUntil: null,
      nextAttemptAt: terminal ? null : retryAt(now, row.attempts),
      lastErrorCode: code,
      updatedAt: new Date(now).toISOString(),
    })
    return true
  })
}

function responseAttemptId(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null
  const attemptId = (response as { attemptId?: unknown }).attemptId
  return typeof attemptId === 'string' ? attemptId : null
}

export async function reserveFallbackSubmission(
  identityId: string,
  raidId: string,
  attemptId: string,
  input: CreateFallbackInput,
  now = Date.now(),
): Promise<NonNullable<CheckInOutboxRecord['fallbackSubmission']> | null> {
  return offlineDb.transaction('rw', offlineDb.identityContext, offlineDb.checkInOutbox, async () => {
    if (!(await identityMatches(identityId))) return null
    const attempt = (await offlineDb.checkInOutbox
      .where('identityId')
      .equals(identityId)
      .filter((row) =>
        row.raidId === raidId &&
        row.status === 'needs_action' &&
        responseAttemptId(row.response) === attemptId,
      )
      .first())
    if (!attempt) return null
    if (attempt.fallbackSubmission) return attempt.fallbackSubmission
    const submission: NonNullable<CheckInOutboxRecord['fallbackSubmission']> = {
      operationId: crypto.randomUUID(),
      input,
      status: 'pending',
      fallbackId: null,
      updatedAt: new Date(now).toISOString(),
    }
    await offlineDb.checkInOutbox.put({ ...attempt, fallbackSubmission: submission })
    return submission
  })
}

export async function settleFallbackSubmission(
  identityId: string,
  raidId: string,
  attemptId: string,
  operationId: string,
  response: FallbackResponse,
  now = Date.now(),
): Promise<boolean> {
  return offlineDb.transaction('rw', offlineDb.identityContext, offlineDb.checkInOutbox, async () => {
    if (!(await identityMatches(identityId))) return false
    const attempt = (await offlineDb.checkInOutbox
      .where('identityId')
      .equals(identityId)
      .filter((row) => row.raidId === raidId && responseAttemptId(row.response) === attemptId)
      .first())
    if (
      !attempt?.fallbackSubmission ||
      attempt.fallbackSubmission.operationId !== operationId ||
      response.fallback.attemptId !== attemptId
    ) return false
    await offlineDb.checkInOutbox.put({
      ...attempt,
      fallbackSubmission: {
        ...attempt.fallbackSubmission,
        status: 'submitted',
        fallbackId: response.fallback.id,
        updatedAt: new Date(now).toISOString(),
      },
    })
    return true
  })
}

export async function getCheckInLocalState(identityId: string, raidId: string) {
  if (!(await identityMatches(identityId))) return { unsynced: 0, needsAction: [] as CheckInOutboxRecord[], media: [] as MediaDraftRecord[] }
  const [checkIns, media] = await Promise.all([
    offlineDb.checkInOutbox.where('identityId').equals(identityId).filter((row) => row.raidId === raidId).toArray(),
    offlineDb.mediaDrafts.where('identityId').equals(identityId).filter((row) => row.raidId === raidId).toArray(),
  ])
  return {
    unsynced: checkIns.filter(({ status }) => ['pending', 'sending', 'retryable'].includes(status)).length +
      media.filter(({ status }) => ['local', 'intent', 'uploading', 'retryable'].includes(status)).length,
    needsAction: checkIns.filter(({ status }) => status === 'needs_action'),
    media,
  }
}

const replayableCheckInStatuses = new Set(['pending', 'sending', 'retryable'])
const replayableMediaStatuses = new Set(['local', 'intent', 'uploading', 'retryable'])

export async function reconcileAndCountUnsyncedCheckInWork(now = Date.now()): Promise<number> {
  return offlineDb.transaction(
    'rw',
    offlineDb.identityContext,
    offlineDb.raidProjections,
    offlineDb.checkInOutbox,
    offlineDb.mediaDrafts,
    async () => {
      const identityId = (await offlineDb.identityContext.get('active'))?.userId
      if (!identityId) return 0
      const [projections, checkIns, media] = await Promise.all([
        offlineDb.raidProjections.where('identityId').equals(identityId).toArray(),
        offlineDb.checkInOutbox.where('identityId').equals(identityId).toArray(),
        offlineDb.mediaDrafts.where('identityId').equals(identityId).toArray(),
      ])
      const stateByRaid = new Map(projections.map((projection) => [projection.raidId, projection.state]))
      const timestamp = new Date(now).toISOString()
      const terminalCheckIns = checkIns
        .filter((row) => replayableCheckInStatuses.has(row.status) && stateByRaid.has(row.raidId) && stateByRaid.get(row.raidId) !== 'active')
        .map((row) => ({
          ...row,
          status: 'rejected' as const,
          claimUntil: null,
          nextAttemptAt: null,
          lastErrorCode: 'RAID_NOT_ACTIVE_LOCAL_RECONCILIATION',
          updatedAt: timestamp,
        }))
      const terminalMedia = media
        .filter((row) => replayableMediaStatuses.has(row.status) && stateByRaid.has(row.raidId) && stateByRaid.get(row.raidId) !== 'active')
        .map((row) => ({
          ...row,
          status: 'rejected' as const,
          claimUntil: null,
          nextAttemptAt: null,
          lastErrorCode: 'RAID_NOT_ACTIVE_LOCAL_RECONCILIATION',
          updatedAt: timestamp,
        }))
      if (terminalCheckIns.length) await offlineDb.checkInOutbox.bulkPut(terminalCheckIns)
      if (terminalMedia.length) await offlineDb.mediaDrafts.bulkPut(terminalMedia)
      return checkIns.length - terminalCheckIns.length === 0 && media.length - terminalMedia.length === 0
        ? 0
        : checkIns.filter((row) => replayableCheckInStatuses.has(row.status) && !terminalCheckIns.some(({ operationId }) => operationId === row.operationId)).length +
          media.filter((row) => replayableMediaStatuses.has(row.status) && !terminalMedia.some(({ operationId }) => operationId === row.operationId)).length
    },
  )
}
