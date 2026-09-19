import { describe, expect, it, vi } from 'vitest'
import type { RaidMedia, RaidMediaPage } from '../checkins/types'
import { loadGalleryWindow } from './gallery-window'
const photo = (id: number): RaidMedia => ({ id: String(id), state: 'ready', contentType: 'image/jpeg', sizeBytes: 100,
  width: 640, height: 480, caption: `Фото ${id}`, purpose: 'gallery', uploaderUserId: 'user', createdAt: '2026-09-19T12:00:00Z' })
const page = (ids: number[], nextCursor: string | null): RaidMediaPage => ({ media: ids.map(photo), nextCursor })
const range = (first: number, count: number) => Array.from({ length: count }, (_, i) => first + i)
const current = () => true

describe('atomic retained gallery window', () => {
  it('refreshes both previously loaded pages instead of returning to the first', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(page(range(1, 24), 'next')).mockResolvedValueOnce(page(range(25, 6), null))
    const result = await loadGalleryWindow(2, current, fetch)
    expect(result.items.map(item => item.id)).toEqual(range(1, 30).map(String))
    expect(result.pageCount).toBe(2)
    expect(result.nextCursor).toBeNull()
  })
  it('includes the old visible tail after newly inserted photos move it to another page', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(page(range(0, 24), 'p2'))
      .mockResolvedValueOnce(page(range(24, 24), 'p3')).mockResolvedValueOnce(page([48], null))
    const result = await loadGalleryWindow(2, current, fetch, '48')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(result.items).toHaveLength(49)
    expect(result.items.at(-1)?.id).toBe('48')
  })
  it('does not return a partial replacement if the second page fails', async () => {
    const previous = { items: range(1, 30).map(photo), nextCursor: null, pageCount: 2 }
    const before = structuredClone(previous)
    const fetch = vi.fn().mockResolvedValueOnce(page(range(1, 24), 'next')).mockRejectedValueOnce(new Error('temporary'))
    await expect(loadGalleryWindow(2, current, fetch, '30')).rejects.toThrow('temporary')
    expect(previous).toEqual(before)
    fetch.mockResolvedValueOnce(page(range(1, 24), 'next')).mockResolvedValueOnce(page(range(25, 6), null))
    expect((await loadGalleryWindow(2, current, fetch, '30')).items).toEqual(previous.items)
  })
  it('keeps an overlap at page boundaries from duplicating images', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(page([1, 2], 'next')).mockResolvedValueOnce(page([2, 3], null))
    expect((await loadGalleryWindow(2, current, fetch)).items.map(item => item.id)).toEqual(['1', '2', '3'])
  })
  it('rejects empty non-terminal pages, duplicate IDs and looping cursors', async () => {
    for (const bad of [page([], 'more'), page([1, 1], null), page(range(1, 25), null)]) {
      await expect(loadGalleryWindow(1, current, vi.fn().mockResolvedValue(bad))).rejects.toThrow()
    }
    const fetch = vi.fn().mockResolvedValueOnce(page([1], 'next')).mockResolvedValueOnce(page([1], 'rotating'))
    await expect(loadGalleryWindow(3, current, fetch)).rejects.toThrow('advance')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('stops before the next request if its identity generation changes', async () => {
    let active = true
    const fetch = vi.fn(async () => { active = false; return page([1], 'next') })
    await expect(loadGalleryWindow(3, () => active, fetch)).rejects.toThrow('superseded')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('accepts a confirmed empty gallery even when an old tail is no longer present', async () => {
    const fetch = vi.fn().mockResolvedValue(page([], null))
    expect(await loadGalleryWindow(4, current, fetch, 'old-photo')).toEqual({ items: [], nextCursor: null, pageCount: 1 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
