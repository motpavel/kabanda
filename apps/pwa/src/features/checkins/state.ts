export type CheckInPrimaryKind = 'claim' | 'verify_fallback' | 'submit_fallback' | 'locate' | 'check_in' | null

export function selectCheckInPrimary(input: {
  hasPendingClaim: boolean
  hasPendingFallback: boolean
  hasManualAttempt: boolean
  hasAcceptedFallbackMedia: boolean
  hasOtherVerifier: boolean
  viewerIsNavigator: boolean
  hasSelectedPoint: boolean
}): CheckInPrimaryKind {
  if (input.hasPendingClaim) return 'claim'
  if (input.hasPendingFallback) return 'verify_fallback'
  if (input.hasManualAttempt) {
    return input.hasAcceptedFallbackMedia && input.hasOtherVerifier ? 'submit_fallback' : null
  }
  if (!input.viewerIsNavigator) return null
  return input.hasSelectedPoint ? 'check_in' : 'locate'
}
