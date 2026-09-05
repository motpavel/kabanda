import { describe, expect, it } from 'vitest'
import { canQueueLocalCheckIn } from './state'
describe('offline evidence queue', () => {
  it('allows cached active members to queue offline, not mutate stale online state', () => {
    expect(canQueueLocalCheckIn('active', true, true, false)).toBe(true)
    expect(canQueueLocalCheckIn('active', true, true, true)).toBe(false)
    expect(canQueueLocalCheckIn('active', false, true, false)).toBe(false)
    for (const state of ['draft', 'paused', 'finalizing', 'completed']) {
      expect(canQueueLocalCheckIn(state, true, true, false)).toBe(false)
    }
  })
})
