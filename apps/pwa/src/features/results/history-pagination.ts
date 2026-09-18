import { historyEntrySchema, historyPageSchema, type HistoryEntry, type HistoryPage, type HistoryScope } from '@kabanda/contracts/exploration'
import { requestJson } from '../../lib/http'

export const HISTORY_PAGE_SIZE = 12
export type HistoryWindow = Omit<HistoryPage, 'raids'> & { raids: HistoryEntry[]; pageCount: number }

export function isHistoryWindow(value: unknown): value is HistoryWindow {
  if (!value || typeof value !== 'object') return false
  const item = value as HistoryWindow
  return item.schemaVersion === 2 && ['all', 'mine'].includes(item.scope) &&
    Array.isArray(item.raids) && item.raids.every(raid => historyEntrySchema.safeParse(raid).success && (item.scope !== 'mine' || raid.participated)) &&
    new Set(item.raids.map(raid => raid.raidId)).size === item.raids.length &&
    Number.isInteger(item.pageCount) && item.pageCount > 0 && item.pageCount <= Math.ceil(item.raids.length / HISTORY_PAGE_SIZE) + 1 &&
    (item.nextCursor === null || (typeof item.nextCursor === 'string' && item.nextCursor.length > 0 && item.nextCursor.length <= 640))
}

export async function fetchHistoryPage(team: string, scope: HistoryScope, cursor?: string): Promise<HistoryPage> {
  const query = new URLSearchParams({ scope, limit: String(HISTORY_PAGE_SIZE) })
  if (cursor) query.set('cursor', cursor)
  const page = historyPageSchema.parse(await requestJson(`/api/kabandas/${encodeURIComponent(team)}/raids/history/page?${query}`))
  if (page.scope !== scope || (scope === 'mine' && page.raids.some(raid => !raid.participated))) throw new Error('History scope mismatch')
  return page
}

/** Refresh the requested window in keyset order. No automatic scan of the whole
 * history. Previously displayed cards stay in the shared resource until every
 * requested page succeeds; a failed last page cannot erase a good first page.
 * Rebuilding the cursor chain also handles new completions inserted at the top
 * without combining incompatible old/new page boundaries. */
export async function loadHistoryWindow(team: string, scope: HistoryScope, pageCount: number,
  current: () => boolean, fetchPage = fetchHistoryPage): Promise<HistoryWindow> {
  const result: HistoryWindow = { schemaVersion: 2, scope, raids: [], nextCursor: null, pageCount: 0 }
  const seenIds = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  const depth = Number.isInteger(pageCount) && pageCount > 0 ? pageCount : 1
  for (let pageIndex = 0; pageIndex < depth; pageIndex++) {
    if (!current()) throw new Error('History read superseded')
    const page = await fetchPage(team, scope, cursor)
    if (!current()) throw new Error('History read superseded')
    if (page.scope !== scope) throw new Error('History scope mismatch')
    result.pageCount++
    for (const raid of page.raids) if (!seenIds.has(raid.raidId)) { seenIds.add(raid.raidId); result.raids.push(raid) }
    result.nextCursor = page.nextCursor
    if (!page.nextCursor) break
    if (seenCursors.has(page.nextCursor) || page.nextCursor === cursor) throw new Error('History cursor did not advance')
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  return result
}
