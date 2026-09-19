import { replayOneCheckInOrMedia, replayOneIssuedMedia } from '../checkins/replay'
import { checkInNeedsAction } from '../checkins/refusal'
import { offlineDb } from '../offline/db'
import { getActiveIdentityId } from '../offline/ledger'
import { fieldInventory, pumpFieldOperations } from '../raids/field-outbox'
import type { FinishLocalReview } from './types'

const routePending = new Set(['pending', 'sending', 'retryable'])
const checkInPending = new Set(['pending', 'sending', 'retryable'])
const mediaPending = new Set(['local', 'intent', 'uploading', 'retryable'])
const MAX_FINISH_INVENTORY_COUNT = 10_000
const boundedCount = (count: number) => Math.min(Math.max(count, 0), MAX_FINISH_INVENTORY_COUNT)

export async function getFinishLocalReview(identityId: string, raidId: string): Promise<FinishLocalReview | null> {
  if ((await getActiveIdentityId()) !== identityId) return null
  const [route, checkIns, media, field] = await Promise.all([
    offlineDb.routeOutbox.where('identityId').equals(identityId).filter(row => row.raidId === raidId).toArray(),
    offlineDb.checkInOutbox.where('identityId').equals(identityId).filter(row => row.raidId === raidId).toArray(),
    offlineDb.mediaDrafts.where('identityId').equals(identityId).filter(row => row.raidId === raidId).toArray(),
    fieldInventory(identityId, raidId),
  ])
  if ((await getActiveIdentityId()) !== identityId) return null
  return { inventory: {
    routePending: boundedCount(route.filter(row => routePending.has(row.status)).length),
    checkInsPending: boundedCount(checkIns.filter(row => checkInPending.has(row.status)).length + field.teamPending),
    mediaPending: boundedCount(media.filter(row => mediaPending.has(row.status)).length + field.materialPending),
    needsAction: boundedCount(checkIns.filter(row => checkInNeedsAction(row, media)).length +
      media.filter(row => row.status === 'rejected').length + field.teamRejected),
  } }
}

function senderTabId(): string {
  const key = 'kabanda:checkin-sender-tab:v1'
  try {
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
    const created = crypto.randomUUID()
    sessionStorage.setItem(key, created)
    return created
  } catch { return crypto.randomUUID() }
}

export async function drainForegroundRaidWork(input: {
  identityId: string; raidId: string; flushRoute: () => Promise<void> | void; online: boolean; maxOperations?: number
}): Promise<FinishLocalReview | null> {
  if (!input.online) return getFinishLocalReview(input.identityId, input.raidId)
  // A slow route batch or photo cannot prevent an already saved visit from
  // starting. Before finish all lanes are nevertheless accounted for.
  await Promise.all([
    Promise.resolve().then(input.flushRoute),
    pumpFieldOperations(input.identityId, input.raidId, 'team'),
    pumpFieldOperations(input.identityId, input.raidId, 'materials'),
  ])
  const holderTabId = senderTabId()
  for (let index = 0; index < (input.maxOperations ?? 20); index += 1) {
    const result = await replayOneCheckInOrMedia({ identityId: input.identityId, raidId: input.raidId, holderTabId, online: true })
    if (result.kind === 'idle' || result.kind === 'retryable' || result.kind === 'fence_lost') break
  }
  return getFinishLocalReview(input.identityId, input.raidId)
}

export async function drainFinalizingServerTail(input: {
  identityId: string; raidId: string; online: boolean; maxOperations?: number
}): Promise<{ processed: number; mayHaveMore: boolean }> {
  if (!input.online) return { processed: 0, mayHaveMore: false }
  // The team endpoint replays an existing receipt after finish, but rejects
  // creation of a new visit. This reconciles a lost ACK without new credit.
  await Promise.all([
    pumpFieldOperations(input.identityId, input.raidId, 'team'),
    pumpFieldOperations(input.identityId, input.raidId, 'materials'),
  ])
  const holderTabId = senderTabId()
  let processed = 0
  for (let index = 0; index < (input.maxOperations ?? 10); index += 1) {
    const result = await replayOneIssuedMedia({ identityId: input.identityId, raidId: input.raidId, holderTabId, online: true })
    if (result.kind === 'idle' || result.kind === 'retryable' || result.kind === 'fence_lost') return { processed, mayHaveMore: false }
    processed += 1
  }
  return { processed, mayHaveMore: true }
}
