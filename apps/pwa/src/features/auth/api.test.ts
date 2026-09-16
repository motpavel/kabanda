import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const requestJson = vi.hoisted(() => vi.fn())
vi.mock('../../lib/http', () => ({ requestJson, ApiError: class ApiError extends Error {} }))
vi.mock('../offline/ledger', () => ({
  IDENTITY_CHANGED_EVENT: 'kabanda:identity-changed',
  activateIdentity: vi.fn().mockResolvedValue(undefined),
  clearActiveIdentity: vi.fn().mockResolvedValue(undefined),
}))
const user = { id: '7484a9f8-11dd-45bd-9740-44b52413fa6b', email: 'test@example.test', username: null, identityKind: 'verified', displayName: 'Test', avatarUrl: null }

beforeEach(() => { vi.resetModules(); requestJson.mockReset(); vi.stubGlobal('window', new EventTarget()) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('recently verified session', () => {
  it('shares a verified user across navigation until the short deadline', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    requestJson.mockResolvedValue({ user })
    const { getCurrentUser } = await import('./api')
    await getCurrentUser()
    expect(await getCurrentUser()).toEqual(user)
    expect(requestJson).toHaveBeenCalledTimes(1)
    clock.mockReturnValue(16000)
    await getCurrentUser()
    expect(requestJson).toHaveBeenCalledTimes(2)
  })

  it('drops the user on account change and cross-tab session change', async () => {
    requestJson.mockResolvedValue({ user })
    const { getCurrentUser } = await import('./api')
    await getCurrentUser()
    window.dispatchEvent(new CustomEvent('kabanda:identity-changed', { detail: { userId: null } }))
    await getCurrentUser()
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'kabanda:relay-session:v1' }))
    await getCurrentUser()
    expect(requestJson).toHaveBeenCalledTimes(3)
  })

  it('does not retain a verified user after logout fails over the network', async () => {
    requestJson.mockResolvedValueOnce({ user }).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ user })
    const { getCurrentUser, logout } = await import('./api')
    await getCurrentUser()
    await expect(logout()).rejects.toThrow('offline')
    await getCurrentUser()
    expect(requestJson).toHaveBeenCalledTimes(3)
  })
})
