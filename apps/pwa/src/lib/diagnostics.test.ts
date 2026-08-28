import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ageBucket,
  attemptBucket,
  classifyDiagnosticError,
  countBucket,
  diagnosticRequestHeaders,
  emitAlphaDiagnostic,
  operationReference,
  queueStallEvent,
  resetDiagnosticsForTests,
  setAlphaDiagnosticsConsent,
  setAlphaDiagnosticsIdentity,
} from './diagnostics'

describe('privacy-safe alpha diagnostics', () => {
  beforeEach(() => {
    vi.stubGlobal('__ALPHA_DIAGNOSTICS__', true)
    vi.stubGlobal('__APP_VERSION__', 'head-123')
    resetDiagnosticsForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('uses bounded deterministic buckets', () => {
    const now = Date.parse('2026-08-28T12:00:00.000Z')
    expect(ageBucket('2026-08-28T11:59:45.000Z', now)).toBe('15_30s')
    expect(ageBucket('2026-08-28T11:59:20.000Z', now)).toBe('30_60s')
    expect(ageBucket('2026-08-28T11:57:00.000Z', now)).toBe('1_5m')
    expect(ageBucket('2026-08-28T11:50:00.000Z', now)).toBe('5m_plus')
    expect(attemptBucket(2)).toBe('0_2')
    expect(attemptBucket(3)).toBe('3_5')
    expect(attemptBucket(6)).toBe('6_plus')
    expect(countBucket(1)).toBe('1')
    expect(countBucket(100)).toBe('21_100')
    expect(classifyDiagnosticError('SESSION_EXPIRED')).toBe('auth')
    expect(classifyDiagnosticError('NETWORK_ERROR')).toBe('network')
  })

  it('uses the same SHA-256 first-16 operation reference as the API', async () => {
    expect(await operationReference('customer-entered-operation-key')).toBe('6953e71acbe75deb')
  })

  it('does not call an offline backlog a stalled queue', () => {
    const now = Date.parse('2026-08-28T12:00:00.000Z')
    const snapshot = {
      queue: 'media' as const,
      count: 3,
      oldestAt: '2026-08-28T11:55:00.000Z',
      maxAttempts: 3,
      lastErrorCode: 'NETWORK_ERROR',
    }
    expect(queueStallEvent(snapshot, snapshot, false, now)).toBeNull()
    expect(queueStallEvent(snapshot, undefined, true, now)).toBeNull()
    expect(queueStallEvent(snapshot, snapshot, true, now)).toMatchObject({
      kind: 'queue_stalled',
      queue: 'media',
      countBucket: '2_5',
      oldestAgeBucket: '5_15m',
      attemptBucket: '3_5',
      errorClass: 'network',
    })
  })

  it('rotates the in-memory diagnostic session within eight hours and on disable', () => {
    setAlphaDiagnosticsIdentity('user-a')
    setAlphaDiagnosticsConsent('user-a', true)
    vi.useFakeTimers()
    vi.setSystemTime('2026-08-28T00:00:00.000Z')
    const first = diagnosticRequestHeaders()['X-Kabanda-Diagnostic-Session']
    vi.setSystemTime('2026-08-28T07:59:59.000Z')
    expect(diagnosticRequestHeaders()['X-Kabanda-Diagnostic-Session']).toBe(first)
    vi.setSystemTime('2026-08-28T08:00:00.000Z')
    const rotated = diagnosticRequestHeaders()['X-Kabanda-Diagnostic-Session']
    expect(rotated).not.toBe(first)
    setAlphaDiagnosticsConsent('user-a', false)
    expect(diagnosticRequestHeaders()['X-Kabanda-Diagnostic-Session']).toBeUndefined()
    setAlphaDiagnosticsConsent('user-a', true)
    expect(diagnosticRequestHeaders()['X-Kabanda-Diagnostic-Session']).not.toBe(rotated)
  })

  it('never lets diagnostic delivery failure escape into the business flow', async () => {
    setAlphaDiagnosticsIdentity('user-a')
    setAlphaDiagnosticsConsent('user-a', true)
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('diagnostics offline')))
    await expect(emitAlphaDiagnostic({ kind: 'gps_stopped', reason: 'storage_error' })).resolves.toBeUndefined()
  })

  it('does not send or create a session before identity-bound consent', async () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    setAlphaDiagnosticsIdentity('user-a')

    expect(diagnosticRequestHeaders()['X-Kabanda-Diagnostic-Session']).toBeUndefined()
    await emitAlphaDiagnostic({ kind: 'gps_stopped', reason: 'unknown' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(setAlphaDiagnosticsConsent('user-b', true)).toBe(false)
    expect(diagnosticRequestHeaders()['X-Kabanda-Diagnostic-Session']).toBeUndefined()
  })
})
