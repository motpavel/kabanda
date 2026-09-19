import type { RaidMedia, RaidMediaPage } from '../checkins/types'

export const GALLERY_PAGE_SIZE = 24
export type GalleryWindow = { items: RaidMedia[]; nextCursor: string | null; pageCount: number }

function validatePage(value: RaidMediaPage): RaidMediaPage {
  if (!value || !Array.isArray(value.media) || value.media.length > GALLERY_PAGE_SIZE ||
    value.media.some(item => !item || typeof item.id !== 'string' || !item.id || item.state !== 'ready' ||
      !Number.isFinite(item.width) || item.width <= 0 || !Number.isFinite(item.height) || item.height <= 0) ||
    new Set(value.media.map(item => item.id)).size !== value.media.length ||
    (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !value.nextCursor || value.nextCursor.length > 2048)) ||
    (value.nextCursor !== null && value.media.length === 0)) throw new TypeError('Invalid gallery page')
  return value
}

/** Publish a complete window, never a partial refresh. Keep reading through
 * the previously displayed tail when new photos shift page boundaries. An
 * authoritative end of list is the only reason to stop before a missing tail.
 * Callers impose a request deadline and fence changes of identity/screen. */
export async function loadGalleryWindow(
  depth: number,
  current: () => boolean,
  fetchPage: (cursor?: string) => Promise<RaidMediaPage>,
  preserveThrough?: string,
): Promise<GalleryWindow> {
  if (!Number.isInteger(depth) || depth < 1) throw new TypeError('Invalid gallery depth')
  const result: GalleryWindow = { items: [], nextCursor: null, pageCount: 0 }
  const ids = new Set<string>(), cursors = new Set<string>()
  let cursor: string | undefined
  for (let index = 0; index < depth || (preserveThrough !== undefined && !ids.has(preserveThrough)); index++) {
    if (!current()) throw new TypeError('Gallery read superseded')
    const response = await fetchPage(cursor)
    if (!current()) throw new TypeError('Gallery read superseded')
    const page = validatePage(response)
    const before = ids.size
    for (const item of page.media) if (!ids.has(item.id)) { ids.add(item.id); result.items.push(item) }
    result.pageCount++; result.nextCursor = page.nextCursor
    if (page.nextCursor === null) break
    if (ids.size === before || cursors.has(page.nextCursor) || cursor === page.nextCursor) throw new TypeError('Gallery cursor did not advance')
    cursors.add(page.nextCursor); cursor = page.nextCursor
  }
  return result
}
