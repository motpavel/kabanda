import type { CapabilitySnapshot, RecorderStatus } from './types'

export const STALE_AFTER_MS = 15_000

export function getDisplayMode(): string {
  if (window.matchMedia('(display-mode: standalone)').matches) return 'standalone'
  if (window.matchMedia('(display-mode: fullscreen)').matches) return 'fullscreen'
  if (window.matchMedia('(display-mode: minimal-ui)').matches) return 'minimal-ui'
  return 'browser'
}

export function getRecorderFreshness(
  lastSampleAt: string | null,
  now = Date.now(),
  staleAfterMs = STALE_AFTER_MS,
): RecorderStatus {
  if (!lastSampleAt) return 'starting'
  return now - Date.parse(lastSampleAt) > staleAfterMs ? 'stale' : 'recording'
}

export function getCapabilitySnapshot(): CapabilitySnapshot {
  const serviceWorker = 'serviceWorker' in navigator
  const registrationPrototype = serviceWorker ? ServiceWorkerRegistration.prototype : undefined
  let canShareFile = false
  try {
    canShareFile =
      'canShare' in navigator &&
      navigator.canShare({ files: [new File(['kabanda'], 'kabanda.txt', { type: 'text/plain' })] })
  } catch {
    canShareFile = false
  }

  return {
    secureContext: window.isSecureContext,
    serviceWorker,
    geolocation: 'geolocation' in navigator,
    permissions: 'permissions' in navigator,
    wakeLock: 'wakeLock' in navigator,
    indexedDb: 'indexedDB' in window,
    cameraCapture: 'mediaDevices' in navigator || 'capture' in document.createElement('input'),
    webShare: 'share' in navigator,
    fileShare: canShareFile,
    backgroundSync: Boolean(registrationPrototype && 'sync' in registrationPrototype),
    storageEstimate: Boolean(navigator.storage?.estimate),
    storagePersist: Boolean(navigator.storage?.persist),
    online: navigator.onLine,
    visibility: document.visibilityState,
    displayMode: getDisplayMode(),
  }
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || Number.isNaN(bytes)) return 'неизвестно'
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КБ`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`
  return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`
}
