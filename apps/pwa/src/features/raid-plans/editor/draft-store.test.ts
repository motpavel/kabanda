import { describe, expect, it } from 'vitest'
import { createRaidTemplateDraft, draftKey, readRaidTemplateDraft, saveRaidTemplateDraft } from './draft-store'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

describe('raid template local draft', () => {
  it('is isolated by identity and Kabanda', () => {
    const storage = memoryStorage()
    const saved = { ...createRaidTemplateDraft('member-a', 'kabanda-a'), title: 'Мой маршрут' }
    expect(saveRaidTemplateDraft(saved, storage)).toBe(true)

    expect(readRaidTemplateDraft('member-a', 'kabanda-a', storage)?.title).toBe('Мой маршрут')
    expect(readRaidTemplateDraft('member-b', 'kabanda-a', storage)).toBeNull()
    expect(readRaidTemplateDraft('member-a', 'kabanda-b', storage)).toBeNull()
    expect(draftKey('member-a', 'kabanda-a')).not.toBe(draftKey('member-b', 'kabanda-a'))
  })

  it('fails closed for malformed local data', () => {
    const storage = memoryStorage()
    storage.setItem(draftKey('member-a', 'kabanda-a'), '{not json')
    expect(readRaidTemplateDraft('member-a', 'kabanda-a', storage)).toBeNull()

    storage.setItem(draftKey('member-a', 'kabanda-a'), JSON.stringify({
      ...createRaidTemplateDraft('member-a', 'kabanda-a'),
      points: [null],
    }))
    expect(readRaidTemplateDraft('member-a', 'kabanda-a', storage)).toBeNull()
  })

  it('scrubs legacy provider estimates instead of persisting them in the local draft', () => {
    const storage = memoryStorage()
    const key = draftKey('member-a', 'kabanda-a')
    storage.setItem(key, JSON.stringify({
      ...createRaidTemplateDraft('member-a', 'kabanda-a'),
      estimate: { status: 'ready', mode: 'bicycle', distanceMeters: 4_200 },
    }))

    const restored = readRaidTemplateDraft('member-a', 'kabanda-a', storage)
    expect(restored).not.toHaveProperty('estimate')
    expect(JSON.parse(storage.getItem(key) ?? '{}')).not.toHaveProperty('estimate')
  })
})
