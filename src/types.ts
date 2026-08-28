export type RecorderStatus =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'stale'
  | 'stopped'
  | 'error'

export interface CapabilitySession {
  id: string
  label: string
  startedAt: string
  updatedAt: string
  endedAt?: string
  userAgent: string
  displayMode: string
  notes: string
  appVersion: string
}

export interface GpsSample {
  id: string
  sessionId: string
  capturedAt: string
  latitude: number
  longitude: number
  accuracy: number
  altitude: number | null
  altitudeAccuracy: number | null
  heading: number | null
  speed: number | null
}

export interface CapabilityEvent {
  id: string
  sessionId: string
  recordedAt: string
  type: string
  detail: Record<string, string | number | boolean | null>
}

export interface CapabilitySetting {
  key: string
  value: string
}

export interface CapabilitySnapshot {
  secureContext: boolean
  serviceWorker: boolean
  geolocation: boolean
  permissions: boolean
  wakeLock: boolean
  indexedDb: boolean
  cameraCapture: boolean
  webShare: boolean
  fileShare: boolean
  backgroundSync: boolean
  storageEstimate: boolean
  storagePersist: boolean
  online: boolean
  visibility: DocumentVisibilityState
  displayMode: string
}

