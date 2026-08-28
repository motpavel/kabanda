import { userSchema, type User } from '@kabanda/contracts'
import { ApiError, requestJson } from '../../lib/http'
import { activateIdentity, clearActiveIdentity } from '../offline/ledger'

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
  const response = await requestJson<{ user: unknown }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  const user = userSchema.parse(response.user)
  await activateIdentity(user.id)
  return user
}

export async function getCurrentUser(): Promise<User> {
  try {
    const response = await requestJson<{ user: unknown }>('/api/me')
    const user = userSchema.parse(response.user)
    await activateIdentity(user.id)
    return user
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) await clearActiveIdentity()
    throw error
  }
}

export async function logout(): Promise<void> {
  try {
    await requestJson<null>('/api/auth/logout', { method: 'POST', body: '{}' })
  } finally {
    await clearActiveIdentity()
  }
}
