import { describe, expect, it } from 'vitest'
import {
  activeParticipantSelection,
  checkInAttentionState,
  participantSelectionKey,
  selectCheckInPrimary,
} from './state'

const base = {
  hasPendingClaim: false,
  hasPendingFallback: false,
  hasManualAttempt: false,
  hasAcceptedFallbackMedia: false,
  hasOtherVerifier: false,
  viewerCanCoordinate: true,
  hasSelectedPoint: false,
}

describe('mobile check-in primary action', () => {
  it('gives a participant claim precedence over navigator actions', () => {
    expect(selectCheckInPrimary({ ...base, hasPendingClaim: true, hasSelectedPoint: true })).toBe('claim')
  })

  it('requires accepted fallback media and a different verifier', () => {
    expect(selectCheckInPrimary({ ...base, hasManualAttempt: true })).toBeNull()
    expect(selectCheckInPrimary({ ...base, hasManualAttempt: true, hasAcceptedFallbackMedia: true })).toBeNull()
    expect(selectCheckInPrimary({ ...base, hasManualAttempt: true, hasAcceptedFallbackMedia: true, hasOtherVerifier: true })).toBe('submit_fallback')
  })

  it('keeps organizer flow to exactly locate or check-in', () => {
    expect(selectCheckInPrimary(base)).toBe('locate')
    expect(selectCheckInPrimary({ ...base, hasSelectedPoint: true })).toBe('check_in')
    expect(selectCheckInPrimary({ ...base, viewerCanCoordinate: false })).toBeNull()
  })
})

describe('organizer participant attestation', () => {
  it('uses a stable key for the exact selected participant set', () => {
    expect(participantSelectionKey(['user-b', 'user-a', 'user-b'])).toBe('user-a:user-b')
    expect(participantSelectionKey(['user-a'])).not.toBe(participantSelectionKey(['user-a', 'user-b']))
  })

  it('drops departed participants before a check-in payload is built', () => {
    expect(activeParticipantSelection(
      'organizer',
      ['organizer', 'still-here', 'departed'],
      new Set(['organizer', 'still-here']),
    )).toEqual(['organizer', 'still-here'])
  })
})

describe('check-in attention outside point proximity', () => {
  it('keeps server claims, fallback verification, and local needs-action discoverable', () => {
    expect(checkInAttentionState({
      claimIds: ['claim-a'],
      fallbackIds: ['fallback-b'],
      manualOperationId: 'operation-c',
      unsynced: 0,
    })).toEqual({
      count: 3,
      key: 'claim:claim-a|fallback:fallback-b|manual:operation-c',
      actionKey: 'claim:claim-a|fallback:fallback-b|manual:operation-c',
    })
  })

  it('keeps offline work visible without reopening a sheet the user collapsed', () => {
    expect(checkInAttentionState({
      claimIds: [],
      fallbackIds: [],
      manualOperationId: null,
      unsynced: 2,
    })).toEqual({ count: 2, key: 'unsynced:2', actionKey: '' })
  })
})
