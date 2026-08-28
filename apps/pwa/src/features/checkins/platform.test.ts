import { describe, expect, it } from 'vitest'
import { eligibleManualVerifier, sha256Hex, validateMediaFile } from './platform'

describe('check-in media boundaries', () => {
  it('hashes source bytes with a stable sha256', async () => {
    expect(await sha256Hex(new Blob(['kabanda']))).toBe('0bd8bb4c0f1b1ae354477c15e4ea9c1cc2acd84cfba00023daa19b008a3e0bd9')
  })

  it('rejects unsupported and oversized media before persistence', () => {
    expect(validateMediaFile(new File(['x'], 'x.gif', { type: 'image/gif' }))).toMatch(/JPEG/)
    expect(validateMediaFile(new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'x.jpg', { type: 'image/jpeg' }))).toMatch(/8 МиБ/)
  })

  it('never permits self-verification or an inactive verifier', () => {
    expect(eligibleManualVerifier('a', 'a', ['a', 'b'])).toBe(false)
    expect(eligibleManualVerifier('a', 'c', ['a', 'b'])).toBe(false)
    expect(eligibleManualVerifier('a', 'b', ['a', 'b'])).toBe(true)
  })
})
