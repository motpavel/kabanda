import Dexie from 'dexie'
import { offlineDb } from './db'
import type { OutboxOperation, OutboxOperationKind } from './types'

export function canReplayOperation(operation: OutboxOperation, activeUserId: string): boolean {
  return operation.identityId === activeUserId && operation.status !== 'sending'
}

export async function activateIdentity(userId: string): Promise<void> {
  await offlineDb.identities.put({ userId, activatedAt: new Date().toISOString() })
}

export async function enqueueOperation(
  identityId: string,
  kind: OutboxOperationKind,
  aggregateId: string,
  payload: unknown,
): Promise<OutboxOperation> {
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
  const operations = await offlineDb.outbox
    .where('[identityId+status+createdAt]')
    .between(
      [activeUserId, 'failed', Dexie.minKey],
      [activeUserId, 'pending', Dexie.maxKey],
      true,
      true,
    )
    .limit(limit)
    .toArray()
  return operations.filter((operation) => canReplayOperation(operation, activeUserId))
}
