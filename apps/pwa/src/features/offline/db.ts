import Dexie, { type EntityTable } from 'dexie'
import type {
  IdentityContext,
  LocalIdentity,
  OutboxOperation,
  PointCollectionProjection,
} from './types'

class KabandaOfflineDatabase extends Dexie {
  identities!: EntityTable<LocalIdentity, 'userId'>
  identityContext!: EntityTable<IdentityContext, 'key'>
  outbox!: EntityTable<OutboxOperation, 'id'>
  pointCollections!: EntityTable<PointCollectionProjection, 'key'>

  constructor() {
    super('kabanda-offline')
    this.version(1).stores({
      identities: 'userId, activatedAt',
      outbox:
        'id, identityId, kind, aggregateId, status, createdAt, [identityId+status+createdAt]',
    })
    this.version(2).stores({
      identities: 'userId, activatedAt',
      identityContext: 'key, userId, changedAt',
      outbox:
        'id, identityId, kind, aggregateId, status, createdAt, [identityId+status+createdAt]',
    })
    this.version(3).stores({
      identities: 'userId, activatedAt',
      identityContext: 'key, userId, changedAt',
      outbox:
        'id, identityId, kind, aggregateId, status, createdAt, [identityId+status+createdAt]',
      pointCollections:
        'key, identityId, kabandaId, collectionId, savedAt, [identityId+kabandaId+collectionId]',
    })
  }
}

export const offlineDb = new KabandaOfflineDatabase()
