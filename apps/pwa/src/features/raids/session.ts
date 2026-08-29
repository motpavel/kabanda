import { ApiError } from '../../lib/http'

export function shouldUseCachedRaidIdentity(error: unknown): boolean {
  return !(error instanceof ApiError && error.status === 401)
}

export function shouldRevalidateCachedRaidSession(
  source: 'canonical' | 'cached',
  online: boolean,
  visibility: DocumentVisibilityState,
): boolean {
  return source === 'cached' && online && visibility === 'visible'
}

export function raidDetailRemountKey(identityId: string, raidId: string): string {
  return JSON.stringify([identityId, raidId])
}
