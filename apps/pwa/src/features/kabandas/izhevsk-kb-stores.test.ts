import { describe, expect, it } from 'vitest'
import { IZHEVSK_KB_STORES, IZHEVSK_KB_STORES_SOURCE, IZHEVSK_KB_STORES_UPDATED_AT } from './izhevsk-kb-stores'

describe('Izhevsk Красное&Белое store snapshot', () => {
  it('contains the complete official snapshot with unique stores', () => {
    expect(IZHEVSK_KB_STORES).toHaveLength(177)
    expect(new Set(IZHEVSK_KB_STORES.map(({ id }) => id)).size).toBe(177)
    expect(IZHEVSK_KB_STORES_SOURCE).toBe('https://krasnoeibeloe.ru/api/cities/1154/shops/')
    expect(IZHEVSK_KB_STORES_UPDATED_AT).toBe('2026-08-31')
  })

  it('keeps every store address and coordinate inside the supported Izhevsk map area', () => {
    for (const store of IZHEVSK_KB_STORES) {
      expect(store.address.trim()).not.toBe('')
      expect(store.hours.trim()).not.toBe('')
      expect(store.latitude).toBeGreaterThanOrEqual(56.74)
      expect(store.latitude).toBeLessThanOrEqual(56.95)
      expect(store.longitude).toBeGreaterThanOrEqual(53.06)
      expect(store.longitude).toBeLessThanOrEqual(53.34)
    }
  })
})
