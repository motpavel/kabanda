import type { RaidProjection } from '../types'
import type { RecorderSessionRecord } from '../../offline/types'
import type { RecorderContext } from './types'

/** A failed READ is not a revocation of an issued navigator lease. These facts
 * only allow capturing evidence locally; they never authorize a server write.
 * Actual access denial removes the projection/identity in the common resources.
 * Every sample is still fenced by the identity and local writer in IndexedDB. */
export function mayCaptureRouteLocally(identityId: string, raid: RaidProjection | null): boolean {
  return Boolean(raid && raid.state === 'active' && raid.navigatorUserId === identityId &&
    raid.navigatorLease && raid.participants.some(person => person.id === identityId && person.state === 'active'))
}

/** Offline/unverified startup may only resume a matching, already wanted local
 * session. It must not create a new lease/session from a cached projection or
 * restart an explicitly stopped recorder. Fresh API state retains the existing
 * online resume behavior. Sending samples remains subject to API authorization. */
export function mayResumeRecorderSession(
  context: RecorderContext,
  session: RecorderSessionRecord | null | undefined,
  staleProjection: boolean,
): boolean {
  return Boolean(session && session.identityId === context.identityId && session.kabandaId === context.kabandaId &&
    session.raidId === context.raidId && session.navigatorLeaseId === context.navigatorLeaseId &&
    session.leaseGeneration === context.leaseGeneration && (!staleProjection || session.wanted))
}
