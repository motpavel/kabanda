import { useCallback, useEffect, useRef, useState } from 'react'
import type { User } from '@kabanda/contracts'
import { getCurrentUser } from './api'
import { sessionFailure, sessionFailureMessage } from './session-policy'
import { IDENTITY_CHANGED_EVENT } from '../offline/ledger'

export type HomeSession =
  | { state: 'loading' }
  | { state: 'anonymous' }
  | { state: 'unavailable'; message: string }
  | { state: 'ready'; user: User; warning: string | null }

/** A transient read failure is not a logout. No persisted identity is promoted
 * to a verified User; an existing view survives only for the same live identity. */
export function useHomeSession(active: boolean) {
  const [session, setSession] = useState<HomeSession>({ state: 'loading' })
  const [checking, setChecking] = useState(false)
  const current = useRef(session)
  const activeRef = useRef(active)
  activeRef.current = active
  const mounted = useRef(false)
  const generation = useRef(0)
  const expectedIdentity = useRef<string | null | undefined>(undefined)
  const pending = useRef<Promise<void> | null>(null)
  const publish = useCallback((next: HomeSession) => {
    current.current = next
    if (mounted.current) setSession(next)
  }, [])
  const refresh = useCallback((): Promise<void> => {
    if (!mounted.current || !activeRef.current) return Promise.resolve()
    if (pending.current) return pending.current
    const token = generation.current
    setChecking(true)
    const request = getCurrentUser().then(user => {
      if (!mounted.current || token !== generation.current) return
      if (expectedIdentity.current !== undefined && expectedIdentity.current !== user.id) return
      expectedIdentity.current = user.id
      publish({ state: 'ready', user, warning: null })
    }).catch(error => {
      if (!mounted.current || token !== generation.current) return
      const kind = sessionFailure(error)
      if (kind === 'anonymous') { publish({ state: 'anonymous' }); return }
      const previous = current.current
      const message = sessionFailureMessage(error)
      if (kind === 'temporary' && previous.state === 'ready' && previous.user.id === expectedIdentity.current) {
        publish({ ...previous, warning: message })
      } else publish({ state: 'unavailable', message })
    }).finally(() => {
      if (pending.current === request) pending.current = null
      if (mounted.current && token === generation.current) setChecking(false)
    })
    pending.current = request
    return request
  }, [publish])

  useEffect(() => {
    mounted.current = true
    const changed = (event: Event) => {
      const id = (event as CustomEvent<{ userId: string | null }>).detail.userId
      expectedIdentity.current = id
      // getCurrentUser itself announces a successful identity before resolving.
      // Do not cancel that initial/same-identity request.
      if (id === null || (current.current.state === 'ready' && current.current.user.id !== id)) {
        generation.current += 1
        pending.current = null
        setChecking(false)
        publish(id === null ? { state: 'anonymous' } : { state: 'loading' })
        if (id !== null) window.setTimeout(() => { void refresh() }, 0)
      }
    }
    const storage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== 'kabanda:relay-session:v1') return
      let id: string | null = null
      try {
        const saved = JSON.parse(event.newValue ?? 'null') as { opaque?: unknown; identityId?: unknown } | null
        if (saved && typeof saved.opaque === 'string' && saved.opaque.length > 0 && saved.opaque.length <= 32_768 && typeof saved.identityId === 'string') id = saved.identityId
      } catch { /* Cleared/corrupt sessions never retain another account's view. */ }
      generation.current += 1
      pending.current = null
      expectedIdentity.current = id
      setChecking(false)
      if (id === null) publish({ state: 'anonymous' })
      else {
        if (current.current.state !== 'ready' || current.current.user.id !== id) publish({ state: 'loading' })
        void refresh()
      }
    }
    const resume = () => {
      if (!activeRef.current || document.visibilityState !== 'visible' || !navigator.onLine) return
      if (current.current.state === 'unavailable' || (current.current.state === 'ready' && current.current.warning)) void refresh()
    }
    window.addEventListener(IDENTITY_CHANGED_EVENT, changed)
    window.addEventListener('storage', storage)
    window.addEventListener('online', resume)
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      mounted.current = false
      generation.current += 1
      pending.current = null
      window.removeEventListener(IDENTITY_CHANGED_EVENT, changed)
      window.removeEventListener('storage', storage)
      window.removeEventListener('online', resume)
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [publish, refresh])

  useEffect(() => {
    if (active) void refresh()
    return () => { generation.current += 1; pending.current = null }
  }, [active, refresh])
  const signedIn = useCallback((user: User) => {
    generation.current += 1
    pending.current = null
    expectedIdentity.current = user.id
    setChecking(false)
    publish({ state: 'ready', user, warning: null })
  }, [publish])
  const signedOut = useCallback(() => {
    generation.current += 1
    pending.current = null
    expectedIdentity.current = null
    setChecking(false)
    publish({ state: 'anonymous' })
  }, [publish])
  return { session, checking, refresh, signedIn, signedOut }
}
