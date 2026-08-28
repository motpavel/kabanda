export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function sanitizeReturnTo(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//')) return '/'
  try {
    const url = new URL(value, 'https://kabanda.invalid')
    if (url.origin !== 'https://kabanda.invalid') return '/'
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return '/'
  }
}

export const IZHEVSK_BOUNDS = {
  minLat: 56.7,
  minLon: 53,
  maxLat: 57,
  maxLon: 53.4,
} as const

export type GeographicBounds = {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
}

export function isBoundedIzhevskQuery(bounds: GeographicBounds): boolean {
  return (
    Number.isFinite(bounds.minLat) &&
    Number.isFinite(bounds.minLon) &&
    Number.isFinite(bounds.maxLat) &&
    Number.isFinite(bounds.maxLon) &&
    bounds.minLat >= IZHEVSK_BOUNDS.minLat &&
    bounds.minLon >= IZHEVSK_BOUNDS.minLon &&
    bounds.maxLat <= IZHEVSK_BOUNDS.maxLat &&
    bounds.maxLon <= IZHEVSK_BOUNDS.maxLon &&
    bounds.minLat < bounds.maxLat &&
    bounds.minLon < bounds.maxLon &&
    bounds.maxLat - bounds.minLat <= 0.2 &&
    bounds.maxLon - bounds.minLon <= 0.25
  )
}

export const RAID_STATES = [
  'draft',
  'planned',
  'lobby',
  'active',
  'paused',
  'finalizing',
  'completed',
  'cancelled',
] as const

export type RaidState = (typeof RAID_STATES)[number]
export type RaidParticipantState =
  | 'invited'
  | 'accepted'
  | 'declined'
  | 'ready'
  | 'active'
  | 'left'
  | 'removed'

export type RaidAction =
  | 'open-lobby'
  | 'accept'
  | 'decline'
  | 'ready'
  | 'assign-navigator'
  | 'start'
  | 'pause'
  | 'resume'
  | 'cancel'

export function isRaidStateTransitionAllowed(state: RaidState, action: RaidAction): boolean {
  switch (action) {
    case 'open-lobby':
      return state === 'draft' || state === 'planned'
    case 'accept':
    case 'decline':
    case 'ready':
    case 'assign-navigator':
    case 'start':
      return state === 'lobby'
    case 'pause':
      return state === 'active'
    case 'resume':
      return state === 'paused'
    case 'cancel':
      return ['draft', 'planned', 'lobby', 'active', 'paused'].includes(state)
  }
}

export function getRaidAllowedActions(input: {
  state: RaidState
  role: 'owner' | 'member'
  participantState: RaidParticipantState | null
  navigatorReady: boolean
}): RaidAction[] {
  const actions: RaidAction[] = []
  if (input.role === 'owner') {
    if (isRaidStateTransitionAllowed(input.state, 'open-lobby')) actions.push('open-lobby')
    if (input.state === 'lobby') {
      actions.push('assign-navigator')
      if (input.navigatorReady) actions.push('start')
    }
    if (input.state === 'active') actions.push('pause')
    if (input.state === 'paused') actions.push('resume')
    if (isRaidStateTransitionAllowed(input.state, 'cancel')) actions.push('cancel')
  }
  if (input.state === 'lobby' && input.participantState === 'invited') {
    actions.push('accept', 'decline')
  }
  if (input.state === 'lobby' && input.participantState === 'accepted') {
    actions.push('ready')
  }
  return actions
}
