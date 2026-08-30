import { ApiError } from '../../lib/http'

export interface InviteLocation {
  hash: string
  pathname: string
  search: string
}

export interface InviteHistory {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void
}

/**
 * Reads a bearer invite exactly once and removes the whole fragment before any
 * network request or React render can copy it into navigation state.
 */
export function consumeInviteFragment(
  location: InviteLocation,
  history: InviteHistory,
): string | null {
  const fragment = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : '')
  const token = fragment.get('invite') ?? fragment.get('token')

  if (location.hash) {
    history.replaceState(null, '', `${location.pathname}${location.search}`)
  }

  return token
}

export async function inviteAcceptanceKey(continuation: string): Promise<string> {
  const bytes = new TextEncoder().encode(continuation)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
  return `invite-${hex}`
}

export type InviteAcceptanceFailure =
  | 'registration-unavailable'
  | 'auth-required'
  | 'invite-invalid'
  | 'retryable'

export function classifyInviteAcceptanceFailure(error: unknown): InviteAcceptanceFailure {
  if (!(error instanceof ApiError)) return 'retryable'
  if (error.code === 'REGISTRATION_UNAVAILABLE') return 'registration-unavailable'
  if (error.code === 'INVITE_INVALID') return 'invite-invalid'
  if (error.status === 401) return 'auth-required'
  return 'retryable'
}
