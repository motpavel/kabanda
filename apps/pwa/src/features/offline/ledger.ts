import Dexie from 'dexie'
import { offlineDb } from './db'
import type { OutboxOperation, OutboxOperationKind } from './types'

export function canReplayOperation(operation: OutboxOperation, activeUserId: string): boolean {
  return operation.identityId === activeUserId && operation.status !== 'sending'
}

export async function activateIdentity(userId: string): Promise<void> {
  const changedAt = new Date().toISOString()
  await offlineDb.transaction('rw', offlineDb.identities, offlineDb.identityContext, async () => {
    await offlineDb.identities.put({ userId, activatedAt: changedAt })
    await offlineDb.identityContext.put({ key: 'active', userId, changedAt })
  })
}

export async function clearActiveIdentity(): Promise<void> {
  await offlineDb.identityContext.delete('active')
}

export async function getActiveIdentityId(): Promise<string | null> {
  return (await offlineDb.identityContext.get('active'))?.userId ?? null
}

export async function enqueueOperation(
  kind: OutboxOperationKind,
  aggregateId: string,
  payload: unknown,
): Promise<OutboxOperation> {
  const identityId = await getActiveIdentityId()
  if (!identityId) throw new Error('Active identity is required before enqueue')
  const identity = await offlineDb.identities.get(identityId)
  if (!identity) throw new Error('Active identity is required before enqueue')

  const operation: OutboxOperation = {
    id: crypto.randomUUID(),
    identityId,
    kind,
    aggregateId,
    payload,
    createdAt: new Date().toISOString(),
    status: 'pending',
    attempts: 0,
  }
  await offlineDb.outbox.add(operation)
  return operation
}

export async function getReplayBatch(activeUserId: string, limit = 50): Promise<OutboxOperation[]> {
  if (limit <= 0 || (await getActiveIdentityId()) !== activeUserId) return []

  const readStatus = (status: 'pending' | 'failed', statusLimit: number) =>
    offlineDb.outbox
      .where('[identityId+status+createdAt]')
      .between(
        [activeUserId, status, Dexie.minKey],
        [activeUserId, status, Dexie.maxKey],
        true,
        true,
      )
      .limit(statusLimit)
      .toArray()

  const pending = await readStatus('pending', limit)
  const failed = await readStatus('failed', limit - pending.length)
  return [...pending, ...failed].filter((operation) =>
    canReplayOperation(operation, activeUserId),
  )
}
