import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearRecordedLocation, publishRecordedLocation, readRecordedLocation, subscribeRecordedLocation } from './live-location'

const key = { identityId: 'rider-a', raidId: 'raid-a' }
const time = Date.parse('2026-09-16T10:00:00Z')
const coordinate = { latitude: 56.85, longitude: 53.2, accuracyMeters: 8, capturedAt: new Date(time).toISOString() }
afterEach(() => clearRecordedLocation(key))

describe('shared persisted GPS', () => {
  it('shares only the same identity and raid and stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    const stop = subscribeRecordedLocation(key, listener)
    publishRecordedLocation(key, coordinate)
    expect(listener).toHaveBeenCalledWith(coordinate)
    expect(readRecordedLocation(key, time)).toBe(coordinate)
    expect(readRecordedLocation({ ...key, identityId: 'other-rider' }, time)).toBeNull()
    expect(readRecordedLocation({ ...key, raidId: 'other-raid' }, time)).toBeNull()
    stop()
    publishRecordedLocation(key, { ...coordinate, capturedAt: new Date(time + 1_000).toISOString() })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('falls back after stale GPS or recorder stop and ignores late samples', () => {
    publishRecordedLocation(key, coordinate)
    publishRecordedLocation(key, { ...coordinate, latitude: 0, capturedAt: new Date(time - 1_000).toISOString() })
    expect(readRecordedLocation(key, time + 5_000)).toBe(coordinate)
    expect(readRecordedLocation(key, time + 5_001)).toBeNull()
    expect(readRecordedLocation(key, time - 5_001)).toBeNull()
    clearRecordedLocation(key)
    expect(readRecordedLocation(key, time)).toBeNull()
  })
})
