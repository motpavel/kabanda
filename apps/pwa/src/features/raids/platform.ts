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

export type LocationIssue = 'denied' | 'unsupported' | 'unavailable' | 'timeout' | 'stale' | 'inaccurate' | 'aborted'

export interface LocalReadinessResult extends LocalReadinessFacts {
  locationIssue: LocationIssue | null
}

interface CoordinateResult {
  coordinateMeasuredAt: string | null
  accuracyM: number | null
  locationIssue: LocationIssue | null
}

export function locationRecoveryMessage(issue: LocationIssue): string {
  const messages: Record<LocationIssue, string> = {
    denied: 'Разрешите доступ к геопозиции для Кабанды в настройках телефона или браузера, затем нажмите «Обновить геолокацию». На iPhone включите «Точная геопозиция».',
    unsupported: 'Геолокация недоступна. Откройте Кабанду по защищённой ссылке HTTPS в браузере телефона.',
    unavailable: 'Телефон не смог определить местоположение. Включите геолокацию в настройках телефона, выйдите на открытое место и повторите проверку.',
    timeout: 'Телефон пока не нашёл GPS. Оставьте Кабанду открытой, выйдите на открытое место и нажмите «Обновить геолокацию».',
    stale: 'Телефон вернул старое местоположение. Оставьте приложение открытым и нажмите «Обновить геолокацию» — запросим новый замер.',
    inaccurate: 'Для старта нужна точность до 100 м. Включите точную геопозицию, выйдите на открытое место и повторите проверку.',
    aborted: 'Проверка геолокации остановлена. Нажмите «Обновить геолокацию», чтобы повторить её.',
  }
  return messages[issue]
}

export async function currentCoordinate(signal?: AbortSignal): Promise<CoordinateResult> {
  const failure = (locationIssue: LocationIssue): CoordinateResult => ({ coordinateMeasuredAt: null, accuracyM: null, locationIssue })
  if (signal?.aborted) return failure('aborted')
  if (!navigator.geolocation) return failure('unsupported')
  return new Promise((resolve) => {
    let settled = false
    let watchId: number | undefined
    let lastIssue: LocationIssue = 'timeout'
    const finish = (result: CoordinateResult) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (watchId !== undefined) navigator.geolocation.clearWatch(watchId)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = () => finish(failure('aborted'))
    // A browser may keep sending cached or coarse fixes: wait for an actual usable
    // update, but never leave a readiness check or GPS subscription running forever.
    const deadline = setTimeout(() => finish(failure(lastIssue)), 25_000)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          if (settled) return
          const age = Date.now() - position.timestamp
          if (!Number.isFinite(age) || age < -5_000 || age > 5_000) {
            lastIssue = 'stale'
            return
          }
          const accuracy = position.coords.accuracy
          if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100) {
            lastIssue = 'inaccurate'
            return
          }
          finish({ coordinateMeasuredAt: new Date(position.timestamp).toISOString(), accuracyM: accuracy, locationIssue: null })
        },
        (error) => {
          if (error.code === 1) finish(failure('denied'))
          else if (error.code === 2) lastIssue = 'unavailable'
          // Timeout is transient for a watch: keep waiting up to the overall deadline.
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 },
      )
      // Also handles synchronous browser shims and immediate permission errors.
      if (settled) navigator.geolocation.clearWatch(watchId)
    } catch {
      finish(failure('unavailable'))
    }
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

export async function collectLocalReadiness(identityId: string, signal?: AbortSignal): Promise<LocalReadinessResult> {
  const permission = await locationPermission()
  const coordinate: CoordinateResult =
    permission === 'denied' || permission === 'unsupported'
      ? { coordinateMeasuredAt: null, accuracyM: null, locationIssue: permission }
      : await currentCoordinate(signal)
  const measuredPermission =
    coordinate.locationIssue === 'denied'
      ? 'denied'
      : coordinate.coordinateMeasuredAt && (permission === 'prompt' || permission === 'unknown')
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
