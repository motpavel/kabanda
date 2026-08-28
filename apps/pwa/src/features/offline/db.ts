import Dexie, { type EntityTable } from 'dexie'
import type {
  IdentityContext,
  LocalIdentity,
  OutboxOperation,
  PointCollectionProjection,
  RecorderSessionRecord,
  RecorderClientRecord,
  RecorderWriterLeaseRecord,
  RaidProjectionRecord,
  RouteOutboxRecord,
} from './types'

class KabandaOfflineDatabase extends Dexie {
  identities!: EntityTable<LocalIdentity, 'userId'>
  identityContext!: EntityTable<IdentityContext, 'key'>
  outbox!: EntityTable<OutboxOperation, 'id'>
  pointCollections!: EntityTable<PointCollectionProjection, 'key'>
  raidProjections!: EntityTable<RaidProjectionRecord, 'key'>
  routeOutbox!: EntityTable<RouteOutboxRecord, 'id'>
  recorderSessions!: EntityTable<RecorderSessionRecord, 'key'>
  recorderClients!: EntityTable<RecorderClientRecord, 'key'>
  recorderWriterLeases!: EntityTable<RecorderWriterLeaseRecord, 'key'>

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
    this.version(4).stores({
      identities: 'userId, activatedAt',
      identityContext: 'key, userId, changedAt',
      outbox:
        'id, identityId, kind, aggregateId, status, createdAt, [identityId+status+createdAt]',
      pointCollections:
        'key, identityId, kabandaId, collectionId, savedAt, [identityId+kabandaId+collectionId]',
      raidProjections:
        'key, identityId, raidId, kabandaId, state, savedAt, [identityId+raidId], [identityId+kabandaId+savedAt], [identityId+savedAt]',
    })
    this.version(5).stores({
      identities: 'userId, activatedAt',
      identityContext: 'key, userId, changedAt',
      outbox:
        'id, identityId, kind, aggregateId, status, createdAt, [identityId+status+createdAt]',
      pointCollections:
        'key, identityId, kabandaId, collectionId, savedAt, [identityId+kabandaId+collectionId]',
      raidProjections:
        'key, identityId, raidId, kabandaId, state, savedAt, [identityId+raidId], [identityId+kabandaId+savedAt], [identityId+savedAt]',
      routeOutbox:
        'id, identityId, raidId, navigatorLeaseId, status, batchId, sequence, [identityId+raidId+navigatorLeaseId+status+sequence]',
      recorderSessions:
        'key, identityId, raidId, navigatorLeaseId, updatedAt, [identityId+raidId+updatedAt]',
      recorderClients:
        'key, identityId, raidId, updatedAt, [identityId+raidId]',
      recorderWriterLeases:
        'key, identityId, raidId, navigatorLeaseId, holderTabId, expiresAt',
    })
  }
}

export const offlineDb = new KabandaOfflineDatabase()
