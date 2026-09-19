import { useCallback, useSyncExternalStore } from 'react'
import { liveRaid } from './live-feed'

const idleSubscribe = () => () => undefined

// The live-feed module clears its registry on these events. A mounted hook must
// observe that replacement even when identityId is unchanged (session renewal).
// Keeping the original feed in a useMemo would retain a retired subscription.
function subscribeRegistry(listener: () => void) {
  if (typeof window === 'undefined') return idleSubscribe()
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === 'kabanda:relay-session:v1') listener()
  }
  window.addEventListener('kabanda:identity-changed', listener)
  window.addEventListener('storage', storage)
  return () => {
    window.removeEventListener('kabanda:identity-changed', listener)
    window.removeEventListener('storage', storage)
  }
}

export function useLiveRaid(identityId: string, raidId: string, active = true) {
  const registeredFeed = useCallback(() => liveRaid(raidId), [identityId, raidId])
  const feed = useSyncExternalStore(subscribeRegistry, registeredFeed, registeredFeed)
  const state = useSyncExternalStore(active ? feed.subscribe : idleSubscribe, feed.snapshot, feed.snapshot)
  return { ...state, refresh: feed.refresh, feed }
}
