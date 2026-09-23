import { useEffect, useRef, useSyncExternalStore } from 'react'
import { cityArchiveStore } from './archive-store'

const readyVersion = () => {
  const state = cityArchiveStore.getSnapshot()
  return state.status === 'ready' ? state.version : null
}

/** An initial range request can fail while the full download succeeds later. */
export function useMapArchiveRecovery(failed: boolean, retry: () => void) {
  // Progress updates must not rerender the whole map/workspace.
  const version = useSyncExternalStore(cityArchiveStore.subscribe, readyVersion, () => null)
  const retriedVersion = useRef<string | null>(null)
  useEffect(() => {
    if (!failed || !version || retriedVersion.current === version) return
    retriedVersion.current = version
    retry()
  }, [failed, version, retry])
}
