import { describe, expect, it, vi } from 'vitest'
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

  it('scrubs legacy provider estimates in memory without mutating storage during read', () => {
    const storage = memoryStorage()
    const key = draftKey('member-a', 'kabanda-a')
    storage.setItem(key, JSON.stringify({
      ...createRaidTemplateDraft('member-a', 'kabanda-a'),
      estimate: { status: 'ready', mode: 'bicycle', distanceMeters: 4_200 },
    }))
    const storedValue = storage.getItem(key)

    const restored = readRaidTemplateDraft('member-a', 'kabanda-a', storage)
    expect(restored).not.toHaveProperty('estimate')
    expect(storage.getItem(key)).toBe(storedValue)
    expect(JSON.parse(storage.getItem(key) ?? '{}')).toHaveProperty('estimate')

    expect(saveRaidTemplateDraft(restored!, storage)).toBe(true)
    expect(JSON.parse(storage.getItem(key) ?? '{}')).not.toHaveProperty('estimate')
  })

  it('restores a JPEG draft without rewriting or deleting it when setItem would fail', () => {
    const draft = {
      ...createRaidTemplateDraft('member-a', 'kabanda-a'),
      title: 'Маршрут с обложкой',
      coverImage: `data:image/jpeg;base64,${'a'.repeat(2_048)}`,
    }
    let storedValue: string | null = JSON.stringify(draft)
    const storage = {
      getItem: vi.fn(() => storedValue),
      setItem: vi.fn(() => {
        throw new Error('QuotaExceededError')
      }),
      removeItem: vi.fn(() => {
        storedValue = null
      }),
    }

    const restored = readRaidTemplateDraft('member-a', 'kabanda-a', storage)

    expect(restored).toMatchObject({
      title: 'Маршрут с обложкой',
      coverImage: draft.coverImage,
    })
    expect(storage.getItem).toHaveBeenCalledOnce()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(storedValue).toBe(JSON.stringify(draft))

    expect(saveRaidTemplateDraft(restored!, storage)).toBe(false)
    expect(storage.setItem).toHaveBeenCalledOnce()
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(storedValue).toBe(JSON.stringify(draft))
  })
})
