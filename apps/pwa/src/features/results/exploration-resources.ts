import { useCallback, useMemo, useState } from 'react'
import type { HistoryScope, PointProgress } from '@kabanda/contracts/exploration'
import { resource as sharedResource, RaidResource, useRaidResource } from '../raids/resources'
import { fetchPointProgress } from '../kabandas/point-progress'
import { HISTORY_PAGE_SIZE, isHistoryWindow, loadHistoryWindow, type HistoryWindow } from './history-pagination'

const desiredDepth = new WeakMap<RaidResource<HistoryWindow>, number>()
const loadedDepth = (entry: RaidResource<HistoryWindow>) => isHistoryWindow(entry.state.data) ? entry.state.data.pageCount : 1

export function pagedHistoryResource(identity: string, team: string, scope: HistoryScope) {
  let entry: RaidResource<HistoryWindow>
  entry = sharedResource<HistoryWindow>(identity, team, 'history', team, { schemaVersion: 2, scope, pageSize: HISTORY_PAGE_SIZE },
    () => loadHistoryWindow(team, scope, Math.max(desiredDepth.get(entry) ?? 1, loadedDepth(entry)), entry.readFence()))
  return entry
}

export async function requestMoreHistory(entry: RaidResource<HistoryWindow>) {
  if (entry.state.status !== 'ready' || !entry.state.data?.nextCursor) return
  desiredDepth.set(entry, loadedDepth(entry) + 1)
  // This synchronous invalidation also prevents a rapid second click from
  // advancing twice. All acceptance, identity and disk-write fences stay shared.
  entry.invalidate(false)
  await entry.refresh()
}

export function usePagedHistory(identity: string, team: string, scope: HistoryScope, active: boolean) {
  const entry = useMemo(() => pagedHistoryResource(identity, team, scope), [identity, team, scope])
  const state = useRaidResource(entry, active, null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const more = useCallback(async () => {
    if (entry.state.status !== 'ready' || !entry.state.data?.nextCursor) return
    setBusyKey(entry.key)
    try { await requestMoreHistory(entry) } finally { setBusyKey(current => current === entry.key ? null : current) }
  }, [entry])
  return { ...state, more, loadingMore: busyKey === entry.key }
}

export const pointProgressResource = (identity: string, team: string, category: PointProgress['category'], collection?: string | null) =>
  sharedResource<PointProgress>(identity, team, 'point-progress', team, { category, collection: category === 'attractions' ? collection ?? null : null },
    () => fetchPointProgress(team, category, collection))

export function usePointProgress(identity: string, team: string, category: PointProgress['category'], collection: string | null, active: boolean) {
  const entry = useMemo(() => pointProgressResource(identity, team, category, collection), [identity, team, category, collection])
  return useRaidResource(entry, active && (category === 'stores' || collection !== null), 30_000)
}
