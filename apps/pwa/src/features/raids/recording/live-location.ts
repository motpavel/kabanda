import type { OneShotCoordinate } from '../../checkins/types'

type Listener = (coordinate: OneShotCoordinate) => void
type LocationKey = { identityId: string; raidId: string }
const locations = new Map<string, OneShotCoordinate>()
const listeners = new Map<string, Set<Listener>>()
const keyFor = ({ identityId, raidId }: LocationKey) => JSON.stringify([identityId, raidId])

/** Only successfully persisted recorder samples are shared; this is not a second GPS watch. */
export function publishRecordedLocation(key: LocationKey, coordinate: OneShotCoordinate) {
  const id = keyFor(key)
  const previous = locations.get(id)
  if (previous && Date.parse(previous.capturedAt) >= Date.parse(coordinate.capturedAt)) return
  locations.set(id, coordinate)
  for (const listener of listeners.get(id) ?? []) {
    // A map subscriber must never turn successfully persisted GPS into a recording failure.
    try { listener(coordinate) } catch { /* Display consumers are optional. */ }
  }
}

export function readRecordedLocation(key: LocationKey, now = Date.now()): OneShotCoordinate | null {
  const coordinate = locations.get(keyFor(key))
  if (!coordinate) return null
  const age = now - Date.parse(coordinate.capturedAt)
  return age >= -5_000 && age <= 5_000 ? coordinate : null
}

export function clearRecordedLocation(key: LocationKey) {
  locations.delete(keyFor(key))
}

export function subscribeRecordedLocation(key: LocationKey, listener: Listener) {
  const id = keyFor(key)
  const group = listeners.get(id) ?? new Set<Listener>()
  group.add(listener)
  listeners.set(id, group)
  return () => {
    group.delete(listener)
    if (!group.size) listeners.delete(id)
  }
}
