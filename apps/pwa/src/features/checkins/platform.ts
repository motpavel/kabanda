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

/** Downsample before hashing, IndexedDB and encrypted transport to bound phone memory. */
export async function prepareMediaFile(file: File): Promise<Blob> {
  if (!MEDIA_TYPES.has(file.type)) throw new Error('Выберите фото в формате JPEG, PNG или WebP. Для HEIC сохраните копию в JPEG.')
  if (file.size <= 0 || file.size > 32 * 1024 * 1024) throw new Error('Выберите фото размером до 32 МиБ.')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { resizeWidth: 2048, resizeQuality: 'high', imageOrientation: 'from-image' })
  } catch {
    throw new Error('Не удалось открыть фото. Сохраните его в JPEG и попробуйте ещё раз.')
  }
  const canvas = document.createElement('canvas')
  try {
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height))
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Не удалось подготовить фото. Попробуйте другой снимок.')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error('Не удалось уменьшить фото. Попробуйте другой снимок.')),
      'image/jpeg', .82,
    ))
    if (blob.size > MAX_MEDIA_BYTES) throw new Error('Фото слишком большое. Выберите другой снимок.')
    return blob
  } finally {
    bitmap.close()
    canvas.width = canvas.height = 1
  }
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
