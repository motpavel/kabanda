import { describe, expect, it } from 'vitest'
import {
  getRaidAllowedActions,
  getRouteStatusCode,
  isBoundedIzhevskQuery,
  isRaidStateTransitionAllowed,
  normalizeEmail,
  sanitizeReturnTo,
} from './index'

describe('identity helpers', () => {
  it('normalizes an email address', () => {
    expect(normalizeEmail('  Pavel@Example.COM ')).toBe('pavel@example.com')
  })

  it.each(['https://evil.example', '//evil.example', 'javascript:alert(1)']) (
    'rejects an unsafe return path: %s',
    (value) => expect(sanitizeReturnTo(value)).toBe('/'),
  )

  it('keeps a local route with query and hash', () => {
    expect(sanitizeReturnTo('/lobby/42?invite=x#ready')).toBe('/lobby/42?invite=x#ready')
  })
})

describe('point query bounds', () => {
  it('accepts a compact Izhevsk viewport', () => {
    expect(
      isBoundedIzhevskQuery({ minLat: 56.8, minLon: 53.1, maxLat: 56.9, maxLon: 53.3 }),
    ).toBe(true)
  })

  it('rejects an oversized or out-of-city viewport', () => {
    expect(
      isBoundedIzhevskQuery({ minLat: 56.7, minLon: 53, maxLat: 57, maxLon: 53.4 }),
    ).toBe(false)
    expect(
      isBoundedIzhevskQuery({ minLat: 55.7, minLon: 53.1, maxLat: 55.8, maxLon: 53.2 }),
    ).toBe(false)
  })
})

describe('raid lifecycle', () => {
  it('keeps terminal states terminal and names valid transitions', () => {
    expect(isRaidStateTransitionAllowed('lobby', 'start')).toBe(true)
    expect(isRaidStateTransitionAllowed('planned', 'open-lobby')).toBe(true)
    expect(isRaidStateTransitionAllowed('active', 'pause')).toBe(true)
    expect(isRaidStateTransitionAllowed('active', 'handoff-navigator')).toBe(true)
    expect(isRaidStateTransitionAllowed('paused', 'resume')).toBe(true)
    expect(isRaidStateTransitionAllowed('completed', 'cancel')).toBe(false)
    expect(isRaidStateTransitionAllowed('cancelled', 'open-lobby')).toBe(false)
  })

  it('exposes start only after navigator readiness', () => {
    expect(
      getRaidAllowedActions({
        state: 'lobby',
        isOrganizer: true,
        participantState: 'accepted',
        navigatorReady: false,
      }),
    ).not.toContain('start')
    expect(
      getRaidAllowedActions({
        state: 'lobby',
        isOrganizer: false,
        participantState: 'accepted',
        navigatorReady: false,
      }),
    ).toContain('ready')
    expect(
      getRaidAllowedActions({
        state: 'lobby',
        isOrganizer: true,
        participantState: 'ready',
        navigatorReady: true,
      }),
    ).toContain('start')
  })

  it('exposes finish, leave and settle only to the eligible actor and state', () => {
    for (const state of ['active', 'paused'] as const) {
      expect(
        getRaidAllowedActions({
          state,
          isOrganizer: true,
          participantState: 'active',
          navigatorReady: false,
        }),
      ).toContain('finish')
      expect(
        getRaidAllowedActions({
          state,
          isOrganizer: false,
          participantState: 'active',
          navigatorReady: false,
        }),
      ).toContain('leave')
    }
    expect(
      getRaidAllowedActions({
        state: 'finalizing',
        isOrganizer: true,
        participantState: 'active',
        navigatorReady: false,
        finalizationCanSettle: false,
      }),
    ).not.toContain('settle-finalization')
    expect(
      getRaidAllowedActions({
        state: 'finalizing',
        isOrganizer: true,
        participantState: 'active',
        navigatorReady: false,
        finalizationCanSettle: true,
      }),
    ).toContain('settle-finalization')
  })

  it('derives raid controls from the raid organizer, not the Kabanda role', () => {
    expect(
      getRaidAllowedActions({
        state: 'draft',
        isOrganizer: true,
        participantState: 'accepted',
        navigatorReady: false,
      }),
    ).toContain('open-lobby')
    expect(
      getRaidAllowedActions({
        state: 'draft',
        isOrganizer: false,
        participantState: 'accepted',
        navigatorReady: false,
      }),
    ).not.toContain('open-lobby')
  })

  it('fails route health closed across lease and pause boundaries', () => {
    expect(
      getRouteStatusCode({
        raidState: 'active',
        leaseClaimed: true,
        leaseHeartbeatFresh: true,
        sampleAgeSeconds: 10,
      }),
    ).toBe('fresh')
    expect(
      getRouteStatusCode({
        raidState: 'active',
        leaseClaimed: false,
        leaseHeartbeatFresh: false,
        sampleAgeSeconds: null,
      }),
    ).toBe('awaiting_lease')
    expect(
      getRouteStatusCode({
        raidState: 'paused',
        leaseClaimed: true,
        leaseHeartbeatFresh: true,
        sampleAgeSeconds: 1,
      }),
    ).toBe('paused')
  })
})
