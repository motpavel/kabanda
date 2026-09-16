import { userSchema, type User } from '@kabanda/contracts'
import { ApiError, requestJson } from '../../lib/http'
import { activateIdentity, clearActiveIdentity, IDENTITY_CHANGED_EVENT } from '../offline/ledger'

// Navigation reuses a recently verified session; routine GPS/presence mutations
// invalidate raid data, but do not require another /me round trip.
let verifiedUser: { user: User; checkedAt: number } | null = null
if (typeof window !== 'undefined') {
  window.addEventListener(IDENTITY_CHANGED_EVENT, (event) => {
    if ((event as CustomEvent<{ userId: string | null }>).detail.userId !== verifiedUser?.user.id) verifiedUser = null
  })
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === 'kabanda:relay-session:v1') verifiedUser = null
  })
}

export async function requestMagicLink(email: string, returnTo = '/'): Promise<void> {
  await requestJson<{ accepted: true }>('/api/auth/request-link', {
    method: 'POST',
    body: JSON.stringify({ email, returnTo }),
  })
}

export async function verifyMagicLink(token: string): Promise<string> {
  const response = await requestJson<{ returnTo: string }>('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
  return response.returnTo
}

export async function loginWithPassword(username: string, password: string): Promise<User> {
  verifiedUser = null
  const response = await requestJson<{ user: unknown }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  const user = userSchema.parse(response.user)
  await activateIdentity(user.id)
  verifiedUser = { user, checkedAt: Date.now() }
  return user
}

export async function getCurrentUser(): Promise<User> {
  if (verifiedUser && Date.now() - verifiedUser.checkedAt < 15_000) return { ...verifiedUser.user }
  try {
    const response = await requestJson<{ user: unknown }>('/api/me', undefined, { maxAgeMs: 15_000 })
    const user = userSchema.parse(response.user)
    await activateIdentity(user.id)
    verifiedUser = { user, checkedAt: Date.now() }
    return user
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) await clearActiveIdentity()
    throw error
  }
}

export async function logout(): Promise<void> {
  verifiedUser = null
  try {
    await requestJson<null>('/api/auth/logout', { method: 'POST', body: '{}' })
  } finally {
    await clearActiveIdentity()
  }
}
