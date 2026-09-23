import { expect, it } from 'vitest'
import { completedTrackRevision } from './completed-track-cache'
import type { RaidLiveSnapshot } from '../live-feed'
const snapshot = { raid: { id: 'raid', state: 'completed', version: 2, routeStatus: { acceptedSampleCount: 4 } }, teamVisits: true, revision: '7' } as RaidLiveSnapshot
it('requires an authoritative field revision and invalidates on accepted route changes', () => {
  expect(completedTrackRevision(snapshot)).not.toBeNull()
  expect(completedTrackRevision({ ...snapshot, revision: '8' })).not.toBe(completedTrackRevision(snapshot))
  expect(completedTrackRevision({ ...snapshot, revision: undefined })).toBeNull()
  expect(completedTrackRevision({ ...snapshot, raid: { ...snapshot.raid, state: 'active' } })).toBeNull()
})
it('supports legacy completed route counters without a field revision', () => {
  const legacy = { ...snapshot, teamVisits: false, revision: undefined }
  expect(completedTrackRevision(legacy)).not.toBeNull()
  expect(completedTrackRevision({ ...legacy, raid: { ...legacy.raid, routeStatus: { ...legacy.raid.routeStatus, acceptedSampleCount: 5 } } })).not.toBe(completedTrackRevision(legacy))
})
