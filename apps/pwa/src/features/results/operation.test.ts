import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearResultOperationAttempt,
  readResultOperationAttempt,
  resultOperationStorageKey,
  saveResultOperationAttempt,
  selectResultOperationAttempt,
} from './operation'

describe('result command attempt', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the exact key and payload for a lost-response retry', () => {
    const payload = { expectedVersion: 8, confirmPartial: true }
    const first = selectResultOperationAttempt(null, 'same', payload, () => 'stable-key')
    expect(selectResultOperationAttempt(first, 'same', { expectedVersion: 9, confirmPartial: false }, () => 'new-key')).toBe(first)
    expect(selectResultOperationAttempt(first, 'changed', payload, () => 'new-key').key).toBe('new-key')
  })

  it('survives remount until a canonical result clears the exact key', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    const attempt = selectResultOperationAttempt(null, 'finish-v8', { expectedVersion: 8 }, () => 'finish-key')
    saveResultOperationAttempt('finish:raid-a', attempt)
    expect(readResultOperationAttempt('finish:raid-a')).toEqual(attempt)
    clearResultOperationAttempt('finish:raid-a', 'another-key')
    expect(readResultOperationAttempt('finish:raid-a')).toEqual(attempt)
    clearResultOperationAttempt('finish:raid-a', 'finish-key')
    expect(readResultOperationAttempt('finish:raid-a')).toBeNull()
  })

  it('binds pending finish and settle attempts to the current identity', () => {
    expect(resultOperationStorageKey('finish', 'user-a', 'raid-a')).not.toBe(
      resultOperationStorageKey('finish', 'user-b', 'raid-a'),
    )
    expect(resultOperationStorageKey('finish', 'user-a', 'raid-a')).not.toBe(
      resultOperationStorageKey('settle', 'user-a', 'raid-a'),
    )
  })
})
