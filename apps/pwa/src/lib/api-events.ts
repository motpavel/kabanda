/** Confirmed writes only; consumers select their resource, never GPS-wide refresh. */
export type ConfirmedWrite = { identityId: string | null | undefined; path: string; body: unknown }
const listeners = new Set<(event: ConfirmedWrite) => void>()
export function subscribeConfirmedWrites(listener: (event: ConfirmedWrite) => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function notifyConfirmedWrite(event: ConfirmedWrite) {
  for (const listener of listeners) {
    // Cache observers must not turn a confirmed server command into a failure.
    try { listener(event) } catch { /* The resource will revalidate on its next read. */ }
  }
}
