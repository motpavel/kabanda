import { describe, expect, it } from 'vitest'
import { selectCheckInPrimary } from './state'

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
