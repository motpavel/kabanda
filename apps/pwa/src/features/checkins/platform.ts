import type { OneShotCoordinate } from './types'

export const MAX_MEDIA_BYTES = 8 * 1024 * 1024
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export function getOneShotCoordinate(timeoutMs = 15_000): Promise<OneShotCoordinate> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('GEOLOCATION_UNAVAILABLE'))
      return
    }
    let settled = false
    let watchId: number | undefined
    const finish = (coordinate: OneShotCoordinate | null, error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (watchId !== undefined) navigator.geolocation.clearWatch(watchId)
      if (coordinate) resolve(coordinate)
      else reject(error)
    }
    const deadline = setTimeout(() => finish(null, new Error('GPS_TIMEOUT')), timeoutMs)
    // A short, independent watch tolerates a temporarily unavailable fix.
    // Never borrow recorder/cache evidence; settle only on a fresh sample.
    try {
      watchId = navigator.geolocation.watchPosition((position) => {
        const age = Date.now() - position.timestamp
        if (!Number.isFinite(age) || age < -5_000 || age > 5_000) return
        finish({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: position.coords.accuracy,
        capturedAt: new Date(position.timestamp).toISOString(),
        })
      }, (error) => {
        if (error.code !== 2 && error.code !== 3) finish(null, error)
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs })
      if (settled) navigator.geolocation.clearWatch(watchId)
    } catch (error) { finish(null, error) }
  })
}

export function validateMediaFile(file: File): string | null {
  if (!MEDIA_TYPES.has(file.type)) return 'Выберите JPEG, PNG или WebP.'
  if (file.size <= 0 || file.size > MAX_MEDIA_BYTES) return 'Файл должен быть не больше 8 МиБ.'
  return null
}

export async function hasQuotaForMedia(fileSize: number): Promise<boolean | null> {
  if (!navigator.storage?.estimate) return null
  try {
    const { quota, usage } = await navigator.storage.estimate()
    if (quota === undefined || usage === undefined) return null
    return quota - usage >= fileSize + 512 * 1024
  } catch {
    return null
  }
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

export function eligibleManualVerifier(
  viewerId: string,
  candidateId: string,
  activeParticipantIds: string[],
): boolean {
  return viewerId !== candidateId && activeParticipantIds.includes(candidateId)
}
