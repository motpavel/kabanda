import { describe, expect, it } from 'vitest'
import { isBoundedIzhevskQuery, normalizeEmail, sanitizeReturnTo } from './index'

describe('identity helpers', () => {
  it('normalizes an email address', () => {
    expect(normalizeEmail('  Pavel@Example.COM ')).toBe('pavel@example.com')
  })

  it.each(['https://evil.example', '//evil.example', 'javascript:alert(1)']) (
    'rejects an unsafe return path: %s',
    (value) => expect(sanitizeReturnTo(value)).toBe('/'),
  )

  it('keeps a local route with query and hash', () => {
    expect(sanitizeReturnTo('/lobby/42?invite=x#ready')).toBe('/lobby/42?invite=x#ready')
  })
})

describe('point query bounds', () => {
  it('accepts a compact Izhevsk viewport', () => {
    expect(
      isBoundedIzhevskQuery({ minLat: 56.8, minLon: 53.1, maxLat: 56.9, maxLon: 53.3 }),
    ).toBe(true)
  })

  it('rejects an oversized or out-of-city viewport', () => {
    expect(
      isBoundedIzhevskQuery({ minLat: 56.7, minLon: 53, maxLat: 57, maxLon: 53.4 }),
    ).toBe(false)
    expect(
      isBoundedIzhevskQuery({ minLat: 55.7, minLon: 53.1, maxLat: 55.8, maxLon: 53.2 }),
    ).toBe(false)
  })
})
