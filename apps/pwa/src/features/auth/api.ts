import { userSchema, type User } from '@kabanda/contracts'
import { requestJson } from '../../lib/http'

export async function requestMagicLink(email: string, returnTo = '/'): Promise<void> {
  await requestJson<{ accepted: true }>('/api/auth/request-link', {
    method: 'POST',
    body: JSON.stringify({ email, returnTo }),
  })
}

export async function getCurrentUser(): Promise<User> {
  const response = await requestJson<{ user: unknown }>('/api/me')
  return userSchema.parse(response.user)
}

export async function logout(): Promise<void> {
  await requestJson<null>('/api/auth/logout', { method: 'POST' })
}
