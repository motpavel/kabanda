import { describe, expect, it } from 'vitest'
import { normalizeEmail, sanitizeReturnTo } from './index'

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
