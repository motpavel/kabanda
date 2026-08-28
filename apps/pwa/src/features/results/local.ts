import { replayOneCheckInOrMedia, replayOneIssuedMedia } from '../checkins/replay'
import { offlineDb } from '../offline/db'
import { getActiveIdentityId } from '../offline/ledger'
import type { FinishLocalReview } from './types'

const routePending = new Set(['pending', 'sending', 'retryable'])
const checkInPending = new Set(['pending', 'sending', 'retryable'])
const mediaPending = new Set(['local', 'intent', 'uploading', 'retryable'])
const MAX_FINISH_INVENTORY_COUNT = 10_000

function boundedCount(count: number): number {
  return Math.min(Math.max(count, 0), MAX_FINISH_INVENTORY_COUNT)
}

export async function getFinishLocalReview(
  identityId: string,
  raidId: string,
): Promise<FinishLocalReview | null> {
  if ((await getActiveIdentityId()) !== identityId) return null
  const [route, checkIns, media] = await Promise.all([
    offlineDb.routeOutbox.where('identityId').equals(identityId).filter((row) => row.raidId === raidId).toArray(),
    offlineDb.checkInOutbox.where('identityId').equals(identityId).filter((row) => row.raidId === raidId).toArray(),
    offlineDb.mediaDrafts.where('identityId').equals(identityId).filter((row) => row.raidId === raidId).toArray(),
  ])
  return {
    inventory: {
      routePending: boundedCount(route.filter(({ status }) => routePending.has(status)).length),
      checkInsPending: boundedCount(checkIns.filter(({ status }) => checkInPending.has(status)).length),
      mediaPending: boundedCount(media.filter(({ status }) => mediaPending.has(status)).length),
      needsAction: boundedCount(
        checkIns.filter(({ status }) => status === 'needs_action').length +
        media.filter(({ status }) => status === 'rejected').length,
      ),
    },
  }
}

function senderTabId(): string {
  const key = 'kabanda:checkin-sender-tab:v1'
  try {
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
    const created = crypto.randomUUID()
    sessionStorage.setItem(key, created)
    return created
  } catch {
    return crypto.randomUUID()
  }
}

export async function drainForegroundRaidWork(input: {
  identityId: string
  raidId: string
  flushRoute: () => Promise<void> | void
  online: boolean
  maxOperations?: number
}): Promise<FinishLocalReview | null> {
  if (!input.online) return getFinishLocalReview(input.identityId, input.raidId)
  await input.flushRoute()
  const holderTabId = senderTabId()
  for (let index = 0; index < (input.maxOperations ?? 20); index += 1) {
    const result = await replayOneCheckInOrMedia({
      identityId: input.identityId,
      raidId: input.raidId,
      holderTabId,
      online: true,
    })
    if (result.kind === 'idle' || result.kind === 'retryable' || result.kind === 'fence_lost') break
    if (result.kind === 'terminal') continue
  }
  return getFinishLocalReview(input.identityId, input.raidId)
}

export async function drainFinalizingServerTail(input: {
  identityId: string
  raidId: string
  online: boolean
  maxOperations?: number
}): Promise<{ processed: number; mayHaveMore: boolean }> {
  if (!input.online) return { processed: 0, mayHaveMore: false }
  const holderTabId = senderTabId()
  let processed = 0
  for (let index = 0; index < (input.maxOperations ?? 10); index += 1) {
    const result = await replayOneIssuedMedia({
      identityId: input.identityId,
      raidId: input.raidId,
      holderTabId,
      online: true,
    })
    if (result.kind === 'idle' || result.kind === 'retryable' || result.kind === 'fence_lost') {
      return { processed, mayHaveMore: false }
    }
    processed += 1
  }
  return { processed, mayHaveMore: true }
}
