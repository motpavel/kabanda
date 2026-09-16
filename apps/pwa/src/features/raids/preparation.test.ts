import { expect, it } from 'vitest'
import { canCheckLocationAutomatically, canStartPreparedRaid, presenceIsCurrent } from './preparation'
import type { RaidPresenceRoster, RaidProjection } from './types'
const now = Date.parse('2026-09-16T12:00:00Z')
const roster = { allReady: true, serverAt: new Date(now).toISOString(), maxAgeSeconds: 30, participants: [{ status: 'nearby', observedAt: new Date(now).toISOString() }] } as RaidPresenceRoster
const raid = { state: 'lobby', organizerUserId: 'owner', navigatorReady: true } as RaidProjection

it('enables one deliberate start only for fresh complete preparation', () => {
  expect(canStartPreparedRaid(raid, 'owner', roster, true, false, now)).toBe(true)
  expect(canStartPreparedRaid(raid, 'member', roster, true, false, now)).toBe(false)
  expect(canStartPreparedRaid(raid, 'owner', roster, false, false, now)).toBe(false)
  expect(canStartPreparedRaid(raid, 'owner', roster, true, true, now)).toBe(false)
  expect(canStartPreparedRaid({ ...raid, navigatorReady: false }, 'owner', roster, true, false, now)).toBe(false)
  expect(canStartPreparedRaid({ ...raid, state: 'active' }, 'owner', roster, true, false, now)).toBe(false)
  expect(presenceIsCurrent(roster, now + 30_000)).toBe(false)
  expect(presenceIsCurrent({ ...roster, allReady: false }, now)).toBe(false)
})

it('keeps GPS automatic after a successful fix on Safari without hiding a revoked permission', () => {
  expect(canCheckLocationAutomatically(undefined, false)).toBe(false)
  expect(canCheckLocationAutomatically(undefined, true)).toBe(true)
  expect(canCheckLocationAutomatically('granted', false)).toBe(true)
  expect(canCheckLocationAutomatically('denied', true)).toBe(false)
  expect(canCheckLocationAutomatically('prompt', true)).toBe(false)
})
