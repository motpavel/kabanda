type Position = { scope: string; index: number }
type Snapshot = { href: string; position: Position; state: Record<string, unknown> }
type Guard = { shouldBlock: (destination: URL) => boolean; message: string }
const POSITION = 'kabanda.navigation.v1'
const listeners = new Set<() => void>()
const beforeListeners = new Set<() => void>()
const guards = new Map<symbol, Guard>()
let committed: Snapshot | null = null
let restoring = false

function positionOf(state: unknown): Position | null {
  if (!state || typeof state !== 'object') return null
  const value = (state as Record<string, unknown>)[POSITION] as Partial<Position> | undefined
  return value && typeof value.scope === 'string' && value.scope.length <= 64 &&
    Number.isSafeInteger(value.index) && value.index! >= 0 ? value as Position : null
}
function stateWithPosition(state: unknown, position: Position): Record<string, unknown> {
  return { ...(state && typeof state === 'object' && !Array.isArray(state) ? state : {}), [POSITION]: position }
}
function capture(): Snapshot {
  const position = positionOf(window.history.state) ?? { scope: crypto.randomUUID(), index: 0 }
  const state = stateWithPosition(window.history.state, position)
  window.history.replaceState(state, '', window.location.href)
  return { href: window.location.href, position, state }
}
function publish() { for (const listener of listeners) listener() }
function beforeNavigation() { for (const listener of beforeListeners) listener() }
function allows(destination: string): boolean {
  if (restoring) return false
  const url = new URL(destination, window.location.href)
  for (const guard of guards.values()) if (guard.shouldBlock(url) && !window.confirm(guard.message)) return false
  return true
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (guards.size === 0) return
  event.preventDefault()
  event.returnValue = ''
}

function restoreFrom(destination: Position | null) {
  if (!committed) return
  if (destination?.scope === committed.position.scope && destination.index !== committed.position.index) {
    restoring = true
    window.history.go(committed.position.index - destination.index)
  } else {
    // A pre-upgrade/untracked same-document entry has no reliable direction.
    // Keep the live screen and recorder, without guessing a history.go delta.
    const position = { scope: crypto.randomUUID(), index: 0 }
    const state = stateWithPosition(committed.state, position)
    window.history.pushState(state, '', committed.href)
    committed = { ...committed, state, position }
    restoring = false
  }
}
function onPopState(event: PopStateEvent) {
  if (!committed) return
  const destination = positionOf(window.history.state)
  if (restoring) {
    event.stopImmediatePropagation()
    if (window.location.href === committed.href && destination?.scope === committed.position.scope && destination.index === committed.position.index) restoring = false
    else restoreFrom(destination)
    return
  }
  if (window.location.href === committed.href && destination?.scope === committed.position.scope && destination.index === committed.position.index) return
  if (!allows(window.location.href)) {
    event.stopImmediatePropagation()
    restoreFrom(destination)
    return
  }
  beforeNavigation()
  committed = capture()
  publish()
}
function ensure() {
  if (committed || typeof window === 'undefined') return
  committed = capture()
  // Browser restoration must not race the identity-scoped screen restoration.
  window.history.scrollRestoration = 'manual'
  // Capture phase precedes route subscribers: a refused Back never unmounts
  // the active map while the browser restores the approved history entry.
  window.addEventListener('popstate', onPopState, true)
}
export function readAppSearch(): string {
  ensure()
  return committed ? new URL(committed.href).search : ''
}
export function subscribeAppLocation(listener: () => void) {
  ensure()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function subscribeBeforeAppNavigation(listener: () => void) {
  ensure()
  beforeListeners.add(listener)
  return () => { beforeListeners.delete(listener) }
}
export function approveAppNavigation(href: string): boolean {
  ensure()
  return allows(href)
}
/** Called only after approveAppNavigation, including the transition callback. */
export function pushApprovedAppLocation(href: string) {
  ensure()
  if (!committed || restoring) return
  beforeNavigation()
  const position = { ...committed.position, index: committed.position.index + 1 }
  window.history.pushState(stateWithPosition(null, position), '', href)
  committed = capture()
  publish()
  window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
}
export function replaceAppLocation(href: string): boolean {
  if (!approveAppNavigation(href) || !committed) return false
  beforeNavigation()
  window.history.replaceState(stateWithPosition(window.history.state, committed.position), '', href)
  committed = capture()
  publish()
  window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
  return true
}
export function registerNavigationGuard(guard: Guard) {
  ensure()
  const token = Symbol('navigation-guard')
  if (guards.size === 0) window.addEventListener('beforeunload', beforeUnload)
  guards.set(token, guard)
  return () => {
    guards.delete(token)
    if (guards.size === 0) window.removeEventListener('beforeunload', beforeUnload)
  }
}
