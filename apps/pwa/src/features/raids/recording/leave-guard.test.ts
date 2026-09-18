import { describe, expect, it } from 'vitest'
import { recorderNeedsLeaveWarning, recordingNavigationLeavesRaid } from './leave-guard'
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

describe('recording route boundaries', () => {
  const raidId = '11111111-1111-4111-8111-111111111111'
  const templateId = '22222222-2222-4222-8222-222222222222'
  const current = new URL(`https://kabanda.example/app?raid=${raidId}`)
  const leaves = (destination: string) => recordingNavigationLeavesRaid(new URL(destination, current), current, raidId)
  it('keeps the same canonical raid and harmless query/hash changes', () => {
    expect(leaves(current.href)).toBe(false)
    expect(leaves(`/app?raid=${raidId}&tab=raids`)).toBe(false)
    expect(leaves(`/app?raid=${raidId}#map`)).toBe(false)
  })
  it('blocks a route-template link even when it also contains the current raid id', () => {
    expect(leaves(`/app?raid=${raidId}&routeTemplate=${templateId}&kabanda=${templateId}`)).toBe(true)
    expect(leaves(`/app?raid=${raidId}&routeTemplate=invalid`)).toBe(true)
  })
  it('blocks another raid, home, a different pathname and external origins', () => {
    expect(leaves(`/app?raid=${templateId}`)).toBe(true)
    expect(leaves('/app?tab=home')).toBe(true)
    expect(leaves(`/invite?raid=${raidId}`)).toBe(true)
    expect(leaves(`https://other.example/app?raid=${raidId}`)).toBe(true)
  })
})
