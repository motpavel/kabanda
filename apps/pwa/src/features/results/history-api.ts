import { ApiError, requestJson } from '../../lib/http'
import type { RaidHistoryFilter, RaidHistoryPage } from './types'
import { newestFirst } from './cache'

export async function listProgressHistory(kabandaId: string, filter: RaidHistoryFilter, limit = 12, cursor?: string): Promise<RaidHistoryPage> {
  const query = new URLSearchParams({ filter, limit: String(Math.min(50, Math.max(1, limit))) })
  if (cursor) query.set('cursor', cursor)
  const value = await requestJson<unknown>(`/api/kabandas/${encodeURIComponent(kabandaId)}/progress/raids/history?${query}`)
  if (!isProgressHistoryPage(value, filter)) throw new ApiError('HISTORY_INVALID', 'Не удалось проверить историю. Повторите загрузку.', 502)
  return value
}

export function isProgressHistoryPage(value: unknown, filter: RaidHistoryFilter): value is RaidHistoryPage {
  if (!value || typeof value !== 'object') return false
  const page = value as RaidHistoryPage
  return Array.isArray(page.raids) && page.raids.length <= 50 &&
    (page.nextCursor === null || (typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 768)) &&
    newestFirst(page).raids.length === page.raids.length &&
    // Never infer participation from a zero/nonzero metric. A filtered response
    // must explicitly attest participation, not silently fall back to the old API.
    page.raids.every(raid => filter === 'all' || raid.participated === true)
}
