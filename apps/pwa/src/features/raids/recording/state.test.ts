import { describe, expect, it } from 'vitest'
import {
  deriveRecorderPhase,
  isPersistedSampleFresh,
  selectActivePrimaryAction,
  shouldDeferServiceWorkerUpdate,
} from './state'

describe('route recorder truth', () => {
  const now = Date.parse('2026-08-28T08:00:15.000Z')

  it('becomes fresh only from a durable sample younger than 15 seconds', () => {
    expect(isPersistedSampleFresh(null, now)).toBe(false)
    expect(isPersistedSampleFresh('2026-08-28T08:00:00.001Z', now)).toBe(true)
    expect(isPersistedSampleFresh('2026-08-28T08:00:00.000Z', now)).toBe(false)
    expect(isPersistedSampleFresh('2026-08-28T08:00:21.000Z', now)).toBe(false)
  })

  it('does not infer green from an active watch without a persisted sample', () => {
    expect(deriveRecorderPhase({
      eligible: true,
      paused: false,
      visible: true,
      ownsWriterLease: true,
      watchActive: true,
      lastPersistedSampleAt: null,
      blocked: false,
      failed: false,
      recovering: false,
      now,
    })).toBe('stale')
  })

  it('keeps exactly one primary action and defers updates while recording is unsafe', () => {
    expect(selectActivePrimaryAction('stale', true)).toBe('recover')
    expect(selectActivePrimaryAction('fresh', true)).toBe('server')
    expect(selectActivePrimaryAction('fresh', false)).toBeNull()
    expect(shouldDeferServiceWorkerUpdate('fresh')).toBe(true)
    expect(shouldDeferServiceWorkerUpdate('stale')).toBe(true)
    expect(shouldDeferServiceWorkerUpdate('paused')).toBe(false)
    expect(shouldDeferServiceWorkerUpdate('paused', 1)).toBe(true)
  })
})
