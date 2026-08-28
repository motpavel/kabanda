import { offlineDb } from './db'

export interface IdentityLocalInventory {
  activeRecordings: number
  routePending: number
  checkInsPending: number
  mediaPending: number
  needsAction: number
  legacyPending: number
  total: number
}

const routePendingStatuses = new Set(['pending', 'sending', 'retryable'])
const checkInPendingStatuses = new Set(['pending', 'sending', 'retryable'])
const mediaPendingStatuses = new Set(['local', 'intent', 'uploading', 'retryable'])
const legacyPendingStatuses = new Set(['pending', 'sending', 'failed'])

export async function getIdentityLocalInventory(identityId: string): Promise<IdentityLocalInventory | null> {
  return offlineDb.transaction(
    'r',
    [
      offlineDb.identityContext,
      offlineDb.outbox,
      offlineDb.routeOutbox,
      offlineDb.recorderSessions,
      offlineDb.checkInOutbox,
      offlineDb.mediaDrafts,
    ],
    async () => {
      const activeIdentityId = (await offlineDb.identityContext.get('active'))?.userId
      if (activeIdentityId !== identityId) return null
      const [legacy, route, recorderSessions, checkIns, media] = await Promise.all([
        offlineDb.outbox.where('identityId').equals(identityId).toArray(),
        offlineDb.routeOutbox.where('identityId').equals(identityId).toArray(),
        offlineDb.recorderSessions.where('identityId').equals(identityId).toArray(),
        offlineDb.checkInOutbox.where('identityId').equals(identityId).toArray(),
        offlineDb.mediaDrafts.where('identityId').equals(identityId).toArray(),
      ])
      const inventory = {
        activeRecordings: recorderSessions.filter(({ wanted }) => wanted).length,
        routePending: route.filter(({ status }) => routePendingStatuses.has(status)).length,
        checkInsPending: checkIns.filter(({ status }) => checkInPendingStatuses.has(status)).length,
        mediaPending: media.filter(({ status }) => mediaPendingStatuses.has(status)).length,
        needsAction: checkIns.filter(({ status }) => status === 'needs_action').length +
          media.filter(({ status }) => status === 'rejected').length,
        legacyPending: legacy.filter(({ status }) => legacyPendingStatuses.has(status)).length,
      }
      return {
        ...inventory,
        total: Object.values(inventory).reduce((sum, count) => sum + count, 0),
      }
    },
  )
}
