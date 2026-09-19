import { describe, expect, it } from 'vitest'
import type { RaidProjection, RaidState, RaidParticipantState } from '../types'
import type { RecorderContext } from './types'
import type { RecorderSessionRecord } from '../../offline/types'
import { mayCaptureRouteLocally, mayResumeRecorderSession } from './local-permission'

const at = '2026-09-19T12:00:00Z'
const context: RecorderContext = { identityId: 'navigator', kabandaId: 'team', raidId: 'raid', navigatorLeaseId: 'issued-lease', leaseGeneration: 2 }
const raid: RaidProjection = {
  id: context.raidId, kabandaId: context.kabandaId, title: 'Offline recording', state: 'active', version: 4,
  scheduledAt: null, description: null, organizerUserId: 'organizer', navigatorUserId: context.identityId,
  navigatorReady: true, navigatorBlockers: [], navigatorWarnings: [], finalization: null, allowedActions: [],
  navigatorLease: { id: context.navigatorLeaseId, generation: context.leaseGeneration, issuedAt: at },
  participants: [{ id: context.identityId, displayName: 'Navigator', avatarUrl: null, state: 'active' }],
  routeStatus: { status: 'fresh', lastSampleAt: at, lastReceivedAt: at, acceptedSampleCount: 1, missingSequenceCount: 0 },
}
const session: RecorderSessionRecord = { ...context, key: 'session-key', clientInstanceId: 'device', wanted: true,
  nextSequence: 2, lastPersistedSampleAt: at, lastLatitude: 56.86, lastLongitude: 53.21,
  preliminaryDistanceM: 0, updatedAt: at }

describe('local recording is distinct from fresh server authorization', () => {
  it('can resume already wanted evidence capture during a transient read outage', () => {
    expect(mayCaptureRouteLocally(context.identityId, raid)).toBe(true)
    expect(mayResumeRecorderSession(context, session, true)).toBe(true)
    expect(mayResumeRecorderSession(context, session, false)).toBe(true)
    // The decision does not mutate the operation sequence, ownership or timestamp.
    expect(session).toMatchObject({ wanted: true, nextSequence: 2, updatedAt: at })
  })
  it('cannot capture with a denied/null projection or without a server-issued lease', () => {
    expect(mayCaptureRouteLocally(context.identityId, null)).toBe(false)
    expect(mayCaptureRouteLocally(context.identityId, { ...raid, navigatorLease: null })).toBe(false)
  })
  it('does not give local recording to another user or an organizer who is not navigator', () => {
    expect(mayCaptureRouteLocally('other-user', raid)).toBe(false)
    expect(mayCaptureRouteLocally('organizer', raid)).toBe(false)
    expect(mayCaptureRouteLocally(context.identityId, { ...raid, navigatorUserId: 'replacement' })).toBe(false)
  })
  it.each<RaidState>(['draft', 'planned', 'lobby', 'paused', 'finalizing', 'completed', 'cancelled'])('stops capture for %s regardless of a retained lease', state => {
    expect(mayCaptureRouteLocally(context.identityId, { ...raid, state })).toBe(false)
  })
  it.each<RaidParticipantState>(['invited', 'accepted', 'ready', 'declined', 'left', 'removed'])('does not capture for a %s participant', state => {
    expect(mayCaptureRouteLocally(context.identityId, { ...raid, participants: [{ ...raid.participants[0]!, state }] })).toBe(false)
  })
  it('never starts an unissued local session from cached state', () => {
    expect(mayResumeRecorderSession(context, undefined, true)).toBe(false)
    expect(mayResumeRecorderSession(context, null, true)).toBe(false)
    expect(mayResumeRecorderSession(context, undefined, false)).toBe(false)
  })
  it('does not restart an explicitly stopped recorder from stale state', () => {
    expect(mayResumeRecorderSession(context, { ...session, wanted: false }, true)).toBe(false)
    expect(mayResumeRecorderSession(context, { ...session, wanted: false }, false)).toBe(true)
  })
  it.each(['identityId', 'kabandaId', 'raidId', 'navigatorLeaseId'] as const)('fences a session with different %s', key => {
    expect(mayResumeRecorderSession(context, { ...session, [key]: 'other' }, true)).toBe(false)
    expect(mayResumeRecorderSession(context, { ...session, [key]: 'other' }, false)).toBe(false)
  })
  it('fences the previous navigator lease generation', () => {
    expect(mayResumeRecorderSession(context, { ...session, leaseGeneration: 1 }, true)).toBe(false)
    expect(mayResumeRecorderSession(context, { ...session, leaseGeneration: 1 }, false)).toBe(false)
  })
})
