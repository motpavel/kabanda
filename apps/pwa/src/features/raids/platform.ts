import { offlineDb } from '../offline/db'
import type { LocalReadinessFacts } from './types'

function appMode(): LocalReadinessFacts['appMode'] {
  return window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser'
}

async function locationPermission(): Promise<LocalReadinessFacts['locationPermission']> {
  if (!('geolocation' in navigator)) return 'unsupported'
  if (!navigator.permissions?.query) return 'unknown'
  try {
    return (await navigator.permissions.query({ name: 'geolocation' })).state
  } catch {
    return 'unknown'
  }
}

async function currentCoordinate(): Promise<{
  coordinateMeasuredAt: string | null
  accuracyM: number | null
}> {
  if (!navigator.geolocation) return { coordinateMeasuredAt: null, accuracyM: null }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          coordinateMeasuredAt: new Date(position.timestamp).toISOString(),
          accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
        }),
      () => resolve({ coordinateMeasuredAt: null, accuracyM: null }),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 12_000 },
    )
  })
}

async function indexedDbWritable(identityId: string): Promise<boolean> {
  try {
    await offlineDb.transaction('rw', offlineDb.identities, async () => {
      const identity = await offlineDb.identities.get(identityId)
      if (!identity) throw new Error('Active identity is missing')
      await offlineDb.identities.put(identity)
    })
    return true
  } catch {
    return false
  }
}

async function storageAvailable(): Promise<boolean | null> {
  if (!navigator.storage?.estimate) return null
  try {
    const estimate = await navigator.storage.estimate()
    if (estimate.quota === undefined || estimate.usage === undefined) return null
    return estimate.quota - estimate.usage >= 5 * 1024 * 1024
  } catch {
    return false
  }
}

export async function collectLocalReadiness(identityId: string): Promise<LocalReadinessFacts> {
  const permission = await locationPermission()
  const coordinate =
    permission === 'denied' || permission === 'unsupported'
      ? { coordinateMeasuredAt: null, accuracyM: null }
      : await currentCoordinate()
  const measuredPermission =
    coordinate.coordinateMeasuredAt && (permission === 'prompt' || permission === 'unknown')
      ? 'granted'
      : permission
  const measuredAt = new Date().toISOString()
  return {
    appMode: appMode(),
    locationPermission: measuredPermission,
    ...coordinate,
    indexedDbWritable: await indexedDbWritable(identityId),
    storageAvailable: await storageAvailable(),
    online: navigator.onLine,
    measuredAt,
    serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
    wakeLockSupported: 'wakeLock' in navigator,
  }
}
