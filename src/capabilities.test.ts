import { describe, expect, it } from 'vitest'
import { formatBytes, getRecorderFreshness } from './capabilities'

describe('getRecorderFreshness', () => {
  it('starts without a sample', () => {
    expect(getRecorderFreshness(null, 20_000)).toBe('starting')
  })

  it('reports a fresh sample as recording', () => {
    expect(getRecorderFreshness('1970-01-01T00:00:10.000Z', 20_000, 15_000)).toBe('recording')
  })

  it('reports an old sample as stale', () => {
    expect(getRecorderFreshness('1970-01-01T00:00:01.000Z', 20_000, 15_000)).toBe('stale')
  })
})

describe('formatBytes', () => {
  it('formats storage evidence for field reports', () => {
    expect(formatBytes(1024)).toBe('1.0 КБ')
    expect(formatBytes(1024 ** 2)).toBe('1.0 МБ')
    expect(formatBytes(undefined)).toBe('неизвестно')
  })
})

