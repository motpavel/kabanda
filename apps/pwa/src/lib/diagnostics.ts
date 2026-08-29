import type { AlphaDiagnosticSignal } from '@kabanda/contracts'

const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1_000
const DIAGNOSTIC_BODY_LIMIT_BYTES = 4 * 1024

type DiagnosticEvent =
  | { kind: 'gps_stale'; ageBucket: '15_30s' | '30_60s' | '1_5m' | '5m_plus' | 'unknown' }
  | { kind: 'gps_stopped'; reason: 'permission_denied' | 'position_unavailable' | 'timeout' | 'storage_error' | 'lease_lost' | 'page_hidden' | 'raid_paused' | 'raid_closed' | 'unknown' }
  | { kind: 'queue_stalled'; queue: 'route' | 'checkin' | 'media'; countBucket: '1' | '2_5' | '6_20' | '21_100' | '100_plus'; oldestAgeBucket: '2_5m' | '5_15m' | '15m_plus'; attemptBucket: '0_2' | '3_5' | '6_plus'; errorClass: DiagnosticErrorClass }
  | { kind: 'media_failed'; stage: 'intent' | 'upload' | 'processing' | 'local_storage'; terminal: boolean; attemptBucket: '0_2' | '3_5' | '6_plus'; errorClass: DiagnosticErrorClass }
  | { kind: 'sw_mismatch'; state: 'waiting_deferred' | 'controller_missing' | 'controller_changed'; durableWorkBucket: '0' | '1_5' | '6_20' | '21_plus'; recorderActive: boolean; activeSwBuild: string | null; waitingSwBuild: string | null }

export type DiagnosticErrorClass = 'network' | 'auth' | 'conflict' | 'server' | 'storage' | 'unknown'

export interface QueueDiagnosticSnapshot {
  queue: 'route' | 'checkin' | 'media'
  count: number
  oldestAt: string | null
  maxAttempts: number
  lastErrorCode: string | null
}

let diagnosticSession: { id: string; createdAt: number } | null = null
let emittedKeys = new Set<string>()
let diagnosticIdentityId: string | null = null
let consentIdentityId: string | null = null

export function alphaDiagnosticsEnabled(): boolean {
  return typeof __ALPHA_DIAGNOSTICS__ !== 'undefined' && __ALPHA_DIAGNOSTICS__ &&
    diagnosticIdentityId !== null && consentIdentityId === diagnosticIdentityId
}

export function setAlphaDiagnosticsIdentity(identityId: string | null): void {
  if (diagnosticIdentityId === identityId) return
  diagnosticIdentityId = identityId
  consentIdentityId = null
  rotateDiagnosticSession()
}

export function alphaDiagnosticsConsentGranted(identityId: string): boolean {
  return diagnosticIdentityId === identityId && consentIdentityId === identityId
}

export function setAlphaDiagnosticsConsent(identityId: string, enabled: boolean): boolean {
  if (!identityId || diagnosticIdentityId !== identityId) return false
  if (!enabled) {
    consentIdentityId = null
    rotateDiagnosticSession()
    return false
  }
  consentIdentityId = identityId
  return true
}

function appBuild(): string {
  return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'test'
}

function session(now = Date.now()) {
  if (!diagnosticSession || now - diagnosticSession.createdAt >= SESSION_MAX_AGE_MS) {
    diagnosticSession = { id: crypto.randomUUID(), createdAt: now }
    emittedKeys = new Set()
  }
  return diagnosticSession
}

function displayMode(): 'browser' | 'standalone' {
  return window.matchMedia?.('(display-mode: standalone)').matches ? 'standalone' : 'browser'
}

export function diagnosticRequestHeaders(): Record<string, string> {
  const headers = { 'X-Kabanda-Client-Build': appBuild() }
  if (!alphaDiagnosticsEnabled()) return headers
  try {
    return { ...headers, 'X-Kabanda-Diagnostic-Session': session().id }
  } catch {
    return headers
  }
}

export async function operationReference(value: string): Promise<string | undefined> {
  try {
    if (!crypto.subtle) return undefined
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16)
  } catch {
    return undefined
  }
}

export function ageBucket(lastAt: string | null, now = Date.now()): '15_30s' | '30_60s' | '1_5m' | '5m_plus' | 'unknown' {
  if (!lastAt) return 'unknown'
  const age = now - Date.parse(lastAt)
  if (!Number.isFinite(age) || age < 0) return 'unknown'
  if (age < 30_000) return '15_30s'
  if (age < 60_000) return '30_60s'
  if (age < 5 * 60_000) return '1_5m'
  return '5m_plus'
}

export function attemptBucket(attempts: number): '0_2' | '3_5' | '6_plus' {
  if (attempts <= 2) return '0_2'
  if (attempts <= 5) return '3_5'
  return '6_plus'
}

export function countBucket(count: number): '1' | '2_5' | '6_20' | '21_100' | '100_plus' {
  if (count <= 1) return '1'
  if (count <= 5) return '2_5'
  if (count <= 20) return '6_20'
  if (count <= 100) return '21_100'
  return '100_plus'
}

export function durableWorkBucket(count: number): '0' | '1_5' | '6_20' | '21_plus' {
  if (count <= 0) return '0'
  if (count <= 5) return '1_5'
  if (count <= 20) return '6_20'
  return '21_plus'
}

export function classifyDiagnosticError(code: string | null | undefined): DiagnosticErrorClass {
  if (!code || code === 'NETWORK_ERROR') return code ? 'network' : 'unknown'
  if (/AUTH|SESSION|UNAUTHORIZED/i.test(code)) return 'auth'
  if (/CONFLICT|STALE|LEASE|FINALIZATION|ALREADY/i.test(code)) return 'conflict'
  if (/STORAGE|QUOTA|INDEXED/i.test(code)) return 'storage'
  if (/INTERNAL|SERVER|PROCESSING|PROVIDER/i.test(code)) return 'server'
  return 'unknown'
}

export function queueStallEvent(
  current: QueueDiagnosticSnapshot,
  previous: QueueDiagnosticSnapshot | undefined,
  online: boolean,
  now = Date.now(),
): Extract<DiagnosticEvent, { kind: 'queue_stalled' }> | null {
  if (!online || !previous || current.count <= 0 || !current.oldestAt) return null
  const oldestAge = now - Date.parse(current.oldestAt)
  if (!Number.isFinite(oldestAge) || oldestAge < 2 * 60_000) return null
  const progressed = current.count < previous.count || current.oldestAt !== previous.oldestAt
  if (progressed && current.maxAttempts < 3) return null
  return {
    kind: 'queue_stalled',
    queue: current.queue,
    countBucket: countBucket(current.count),
    oldestAgeBucket: oldestAge < 5 * 60_000 ? '2_5m' : oldestAge < 15 * 60_000 ? '5_15m' : '15m_plus',
    attemptBucket: attemptBucket(current.maxAttempts),
    errorClass: classifyDiagnosticError(current.lastErrorCode),
  }
}

export async function emitAlphaDiagnostic(
  event: DiagnosticEvent,
  options: { operationRef?: string; swBuild?: string | null } = {},
): Promise<void> {
  if (!alphaDiagnosticsEnabled()) return
  try {
    const currentSession = session()
    const signal: AlphaDiagnosticSignal = {
      schemaVersion: 1,
      signalId: crypto.randomUUID(),
      diagnosticSessionId: currentSession.id,
      occurredAt: new Date().toISOString(),
      clientBuild: appBuild(),
      swBuild: options.swBuild ?? null,
      displayMode: displayMode(),
      ...(options.operationRef ? { operationRef: options.operationRef } : {}),
      ...event,
    }
    const body = JSON.stringify(signal)
    if (new TextEncoder().encode(body).byteLength > DIAGNOSTIC_BODY_LIMIT_BYTES) return
    await fetch('/api/diagnostics/signals', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: {
        'content-type': 'application/json',
        'X-Kabanda-Client-Build': appBuild(),
        'X-Kabanda-Diagnostic-Session': currentSession.id,
      },
      body,
    })
  } catch {
    // Alpha diagnostics are deliberately best-effort and never enter the business outbox.
  }
}

export async function emitAlphaDiagnosticOnce(
  key: string,
  event: DiagnosticEvent,
  options?: { operationRef?: string; swBuild?: string | null },
): Promise<void> {
  if (!alphaDiagnosticsEnabled() || emittedKeys.has(key)) return
  emittedKeys.add(key)
  await emitAlphaDiagnostic(event, options)
}

export async function readServiceWorkerBuild(worker: ServiceWorker | null, timeoutMs = 1_000): Promise<string | null> {
  if (!worker) return null
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = window.setTimeout(() => resolve(null), timeoutMs)
    channel.port1.onmessage = (message) => {
      window.clearTimeout(timer)
      const build = message.data?.build
      resolve(typeof build === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(build) ? build : null)
    }
    worker.postMessage({ type: 'KABANDA_SW_BUILD' }, [channel.port2])
  })
}

export function rotateDiagnosticSession(): void {
  diagnosticSession = null
  emittedKeys = new Set()
}

export function resetDiagnosticsForTests(): void {
  rotateDiagnosticSession()
  diagnosticIdentityId = null
  consentIdentityId = null
}
