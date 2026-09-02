export type CheckInPrimaryKind = 'claim' | 'verify_fallback' | 'submit_fallback' | 'locate' | 'check_in' | null

export function participantSelectionKey(participantIds: readonly string[]): string {
  return Array.from(new Set(participantIds)).sort().join(':')
}

export function activeParticipantSelection(
  identityId: string,
  selectedParticipantIds: readonly string[],
  activeParticipantIds: ReadonlySet<string>,
): string[] {
  const selected = selectedParticipantIds.filter((id) => activeParticipantIds.has(id))
  if (activeParticipantIds.has(identityId)) selected.push(identityId)
  return Array.from(new Set(selected))
}

export function checkInAttentionState(input: {
  claimIds: readonly string[]
  fallbackIds: readonly string[]
  manualOperationId: string | null
  unsynced: number
}): { count: number; key: string; actionKey: string } {
  const actionKeys = [
    ...input.claimIds.map((id) => `claim:${id}`),
    ...input.fallbackIds.map((id) => `fallback:${id}`),
    ...(input.manualOperationId ? [`manual:${input.manualOperationId}`] : []),
  ]
  const keys = [...actionKeys, ...(input.unsynced > 0 ? [`unsynced:${input.unsynced}`] : [])]
  return {
    count: input.claimIds.length + input.fallbackIds.length +
      (input.manualOperationId ? 1 : 0) + input.unsynced,
    key: keys.join('|'),
    actionKey: actionKeys.join('|'),
  }
}

export function selectCheckInPrimary(input: {
  hasPendingClaim: boolean
  hasPendingFallback: boolean
  hasManualAttempt: boolean
  hasAcceptedFallbackMedia: boolean
  hasOtherVerifier: boolean
  viewerCanCoordinate: boolean
  hasSelectedPoint: boolean
}): CheckInPrimaryKind {
  if (input.hasPendingClaim) return 'claim'
  if (input.hasPendingFallback) return 'verify_fallback'
  if (input.hasManualAttempt) {
    return input.hasAcceptedFallbackMedia && input.hasOtherVerifier ? 'submit_fallback' : null
  }
  if (!input.viewerCanCoordinate) return null
  return input.hasSelectedPoint ? 'check_in' : 'locate'
}
