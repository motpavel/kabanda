import { describe, expect, it } from 'vitest'
import { recorderNeedsLeaveWarning } from './leave-guard'
import type { RecorderPhase } from './types'

describe('recording navigation warning scope', () => {
  const raid = { state: 'active' as const, navigatorUserId: 'navigator' }
  it('warns only the active navigator while this device records or recovers', () => {
    for (const phase of ['fresh', 'waiting', 'recovering', 'stale'] as RecorderPhase[]) {
      expect(recorderNeedsLeaveWarning('navigator', raid, phase)).toBe(true)
      expect(recorderNeedsLeaveWarning('participant', raid, phase)).toBe(false)
    }
  })
  it('does not trap paused/completed rides or another recording device', () => {
    for (const phase of ['standby', 'error', 'blocked', 'paused', 'ineligible'] as RecorderPhase[]) expect(recorderNeedsLeaveWarning('navigator', raid, phase)).toBe(false)
    expect(recorderNeedsLeaveWarning('navigator', { ...raid, state: 'paused' }, 'fresh')).toBe(false)
    expect(recorderNeedsLeaveWarning('navigator', { ...raid, state: 'completed' }, 'fresh')).toBe(false)
    expect(recorderNeedsLeaveWarning('navigator', null, 'fresh')).toBe(false)
  })
})
