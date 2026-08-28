import { describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/http'
import {
  raidDetailRemountKey,
  shouldRevalidateCachedRaidSession,
  shouldUseCachedRaidIdentity,
} from './session'

describe('raid session fallback', () => {
  it('shows sign-in only for an explicit 401', () => {
    expect(shouldUseCachedRaidIdentity(new ApiError('UNAUTHORIZED', 'Войдите', 401))).toBe(false)
  })

  it('allows identity-bound stale fallback for network and server failures', () => {
    expect(shouldUseCachedRaidIdentity(new TypeError('Failed to fetch'))).toBe(true)
    expect(shouldUseCachedRaidIdentity(new ApiError('SERVER_ERROR', 'Ошибка сервера', 503))).toBe(true)
  })

  it('revalidates only a visible online cached session', () => {
    expect(shouldRevalidateCachedRaidSession('cached', true, 'visible')).toBe(true)
    expect(shouldRevalidateCachedRaidSession('cached', false, 'visible')).toBe(false)
    expect(shouldRevalidateCachedRaidSession('cached', true, 'hidden')).toBe(false)
    expect(shouldRevalidateCachedRaidSession('canonical', true, 'visible')).toBe(false)
  })

  it('forces a detail remount when identity changes for the same raid', () => {
    const raidId = '11111111-1111-4111-8111-111111111111'
    expect(raidDetailRemountKey('identity-a', raidId)).not.toBe(
      raidDetailRemountKey('identity-b', raidId),
    )
    expect(raidDetailRemountKey('identity-a', raidId)).toBe(
      raidDetailRemountKey('identity-a', raidId),
    )
  })
})
