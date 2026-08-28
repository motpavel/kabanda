import Dexie, { type EntityTable } from 'dexie'
import type { LocalIdentity, OutboxOperation } from './types'

class KabandaOfflineDatabase extends Dexie {
  identities!: EntityTable<LocalIdentity, 'userId'>
  outbox!: EntityTable<OutboxOperation, 'id'>

  constructor() {
    super('kabanda-offline')
    this.version(1).stores({
      identities: 'userId, activatedAt',
      outbox:
        'id, identityId, kind, aggregateId, status, createdAt, [identityId+status+createdAt]',
    })
  }
}

export const offlineDb = new KabandaOfflineDatabase()
