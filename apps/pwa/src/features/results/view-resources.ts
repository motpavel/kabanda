import { useCallback, useState } from 'react'
import type { PointVisitHistory } from '@kabanda/contracts'
import { ApiError, requestJson } from '../../lib/http'
import { getActiveIdentityId } from '../offline/ledger'
import { getRaidMapPoints, getRaidSnapshot } from '../raids/api'
import { isRaidProjection } from '../raids/cache'
import type { RaidLiveSnapshot } from '../raids/live-feed'
import { RaidResource, resource, useRaidResource } from '../raids/resources'
import type { PointMaterial } from '../checkins/PointMaterialsPanel'
import type { RaidMediaPage } from '../checkins/types'
import { GALLERY_PAGE_SIZE, loadGalleryWindow, type GalleryWindow } from './gallery-window'

export const COMPLETED_REFRESH_MS = 60_000
const desiredDepth = new WeakMap<object, number>()
const text = (value: unknown): value is string => typeof value === 'string'
const date = (value: unknown) => text(value) && Number.isFinite(Date.parse(value))
const cursor = (value: unknown) => value === null || (text(value) && value.length > 0 && value.length <= 2048)
const unique = (rows: { id: string }[]) => new Set(rows.map(row => row.id)).size === rows.length
const windowShape = (value: { items: { id: string }[]; pageCount: number; nextCursor: string | null }) =>
  Array.isArray(value.items) && Number.isInteger(value.pageCount) && value.pageCount > 0 &&
  value.pageCount <= value.items.length + 1 && cursor(value.nextCursor) && (!value.nextCursor || value.items.length > 0) && unique(value.items)

/** A component leaving the screen does not abort a read shared by another
 * consumer. Identity/revocation fences and a deadline own its lifetime. */
async function withRead<T>(entry: RaidResource<T>, read: (signal: AbortSignal, current: () => boolean) => Promise<T>) {
  const valid = entry.readFence(), controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 15_000)
  const current = () => valid() && !controller.signal.aborted
  try {
    if (!current() || await getActiveIdentityId() !== entry.identityId) throw new TypeError('View identity changed')
    const value = await read(controller.signal, current)
    if (!current() || await getActiveIdentityId() !== entry.identityId) throw new TypeError('View identity changed')
    return value
  } finally { clearTimeout(deadline) }
}

export function completedPointsResource(identity: string, team: string, raidId: string) {
  const valid = (value: unknown): value is RaidLiveSnapshot => {
    const snapshot = value as RaidLiveSnapshot | null
    return !!snapshot && isRaidProjection(snapshot.raid) && snapshot.raid.id === raidId && snapshot.raid.kabandaId === team &&
      typeof snapshot.teamVisits === 'boolean' && Array.isArray(snapshot.points) && snapshot.points.every(point =>
        !!point && text(point.id) && text(point.name) && Number.isFinite(point.latitude) && Number.isFinite(point.longitude) &&
        typeof point.visitedByMe === 'boolean' && typeof point.visitedByTeam === 'boolean')
  }
  return resource<RaidLiveSnapshot>(identity, team, 'raid-view', raidId, { view: 'points', version: 1 }, async () => {
    const snapshot = await getRaidSnapshot(raidId)
    if ((snapshot as { fieldVisible?: boolean }).fieldVisible === false) throw new ApiError('FORBIDDEN', 'Field unavailable', 403)
    // Persist only the static view, never live positions or inbox permissions.
    return { raid: snapshot.raid, ...(snapshot.revision ? { revision: snapshot.revision } : {}), teamVisits: snapshot.teamVisits === true,
      points: snapshot.points ?? await getRaidMapPoints(raidId), ...(snapshot.track ? { track: snapshot.track } : {}) }
  }, valid)
}

export const validGalleryWindow = (value: unknown): value is GalleryWindow => {
  const window = value as GalleryWindow | null
  return !!window && Array.isArray(window.items) && window.items.every(item => item && text(item.id) && item.state === 'ready' &&
    date(item.createdAt) && (item.caption === null || text(item.caption)) && Number.isFinite(item.width) && item.width > 0 &&
    Number.isFinite(item.height) && item.height > 0) && windowShape(window)
}
export function galleryResource(identity: string, team: string, raidId: string) {
  let entry: RaidResource<GalleryWindow>
  entry = resource(identity, team, 'raid-view', raidId, { view: 'gallery', version: 1 }, () => withRead(entry, (signal, current) =>
    loadGalleryWindow(Math.max(desiredDepth.get(entry) ?? 1, entry.state.data?.pageCount ?? 1), current, after => {
      const query = new URLSearchParams({ limit: String(GALLERY_PAGE_SIZE) })
      if (after) query.set('cursor', after)
      return requestJson<RaidMediaPage>(`/api/raids/${encodeURIComponent(raidId)}/media?${query}`, { signal })
    }, entry.state.data?.items.at(-1)?.id)), validGalleryWindow)
  return entry
}

export type MaterialsWindow = { items: PointMaterial[]; nextCursor: string | null; pageCount: number; canWrite: boolean }
type MaterialsPage = { materials: PointMaterial[]; nextCursor: string | null; canWrite?: boolean }
export const validMaterial = (value: PointMaterial, pointId: string) => value && text(value.id) && !!value.id &&
  value.pointSnapshotId === pointId && value.ready === true && ['comment', 'photo'].includes(value.kind) &&
  text(value.body) && text(value.authorName) && text(value.authorUserId) && date(value.createdAt) &&
  (value.width === null || Number.isFinite(value.width)) && (value.height === null || Number.isFinite(value.height))
export function validMaterialsWindow(value: unknown, pointId: string): value is MaterialsWindow {
  const window = value as MaterialsWindow | null
  return !!window && Array.isArray(window.items) && window.items.every(item => validMaterial(item, pointId)) &&
    typeof window.canWrite === 'boolean' && windowShape(window)
}
export async function loadMaterialsWindow(depth: number, pointId: string, current: () => boolean,
  fetchPage: (after?: string) => Promise<MaterialsPage>, preserveThrough?: string): Promise<MaterialsWindow> {
  const result: MaterialsWindow = { items: [], nextCursor: null, pageCount: 0, canWrite: false }
  const ids = new Set<string>(), cursors = new Set<string>()
  let after: string | undefined
  for (let index = 0; index < depth || (preserveThrough !== undefined && !ids.has(preserveThrough)); index++) {
    if (!current()) throw new TypeError('Materials read superseded')
    const page = await fetchPage(after)
    if (!current()) throw new TypeError('Materials read superseded')
    if (!page || !Array.isArray(page.materials) || !page.materials.every(item => validMaterial(item, pointId)) ||
      !unique(page.materials) || !cursor(page.nextCursor) || (page.nextCursor !== null && !page.materials.length) ||
      (page.canWrite !== undefined && typeof page.canWrite !== 'boolean')) throw new TypeError('Invalid materials page')
    if (index === 0) result.canWrite = page.canWrite === true
    const before = ids.size
    for (const item of page.materials) if (!ids.has(item.id)) { ids.add(item.id); result.items.push(item) }
    result.nextCursor = page.nextCursor; result.pageCount++
    if (page.nextCursor === null) break
    if (ids.size === before || cursors.has(page.nextCursor) || page.nextCursor === after) throw new TypeError('Materials cursor did not advance')
    cursors.add(page.nextCursor); after = page.nextCursor
  }
  return result
}
export function materialsResource(identity: string, team: string, raidId: string, pointId: string) {
  let entry: RaidResource<MaterialsWindow>
  entry = resource(identity, team, 'raid-view', raidId, { view: 'materials', pointId, version: 1 }, () => withRead(entry, (signal, current) =>
    loadMaterialsWindow(Math.max(desiredDepth.get(entry) ?? 1, entry.state.data?.pageCount ?? 1), pointId, current,
      after => requestJson<MaterialsPage>(`/api/raids/${encodeURIComponent(raidId)}/points/${encodeURIComponent(pointId)}/materials${after ? `?cursor=${encodeURIComponent(after)}` : ''}`, { signal }),
      entry.state.data?.items.at(-1)?.id)), value => validMaterialsWindow(value, pointId))
  return entry
}

export async function requestMoreView<T extends { pageCount: number; nextCursor: string | null }>(entry: RaidResource<T>) {
  // Preserve a click made while focus revalidation is in flight.
  await entry.waitForRead()
  if (entry.state.status !== 'ready' || !entry.state.data?.nextCursor) return
  desiredDepth.set(entry, entry.state.data.pageCount + 1)
  entry.invalidate(false)
  await entry.refresh()
}
export function useViewWindow<T extends { pageCount: number; nextCursor: string | null }>(entry: RaidResource<T>, active: boolean, interval = COMPLETED_REFRESH_MS) {
  const state = useRaidResource(entry, active, interval, interval)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const more = useCallback(async () => {
    if (busyKey === entry.key) return
    setBusyKey(entry.key)
    try { await requestMoreView(entry) } finally { setBusyKey(key => key === entry.key ? null : key) }
  }, [entry, busyKey])
  return { ...state, more, loadingMore: busyKey === entry.key }
}

export function validVisitHistory(value: unknown): value is PointVisitHistory {
  const history = value as PointVisitHistory | null
  return !!history && Number.isInteger(history.personalCount) && history.personalCount >= 0 &&
    (history.nextOffset === null || (Number.isInteger(history.nextOffset) && history.nextOffset > 0)) &&
    Array.isArray(history.visitors) && history.visitors.every(visitor => visitor && text(visitor.userId) && text(visitor.displayName) && Number.isInteger(visitor.count) && visitor.count >= 0) &&
    Array.isArray(history.entries) && history.entries.every(item => item && text(item.id) && text(item.title) && date(item.visitedAt) &&
      (item.raidId === null || text(item.raidId)) && Array.isArray(item.participants) && item.participants.every(person => person && text(person.userId) && text(person.displayName)) &&
      Array.isArray(item.visits) && item.visits.every(visit => visit && text(visit.id) && text(visit.userId) && text(visit.displayName) && date(visit.visitedAt)))
}
export type VisitHistoryWindow = PointVisitHistory & { pageCount: number; nextCursor: string | null }
export function visitHistoryResource(identity: string, team: string, pointId: string, visitorId?: string) {
  let entry: RaidResource<VisitHistoryWindow>
  entry = resource(identity, team, 'point-history', pointId, { pointId, visitorId: visitorId ?? null, version: 2 },
    () => withRead(entry, async (signal, current) => {
      const depth = visitorId ? Math.max(desiredDepth.get(entry) ?? 1, entry.state.data?.pageCount ?? 1) : 1
      const tail = visitorId ? entry.state.data?.entries.at(-1)?.id : undefined
      let offset = 0, result: VisitHistoryWindow | null = null
      const ids = new Set<string>()
      for (let index = 0; index < depth || (tail !== undefined && !ids.has(tail)); index++) {
        if (!current()) throw new TypeError('History read superseded')
        const page = await requestJson<PointVisitHistory>(`/api/kabandas/${encodeURIComponent(team)}/points/${encodeURIComponent(pointId)}/history${visitorId ? `?visitorId=${encodeURIComponent(visitorId)}&offset=${offset}` : ''}`, { signal })
        if (!validVisitHistory(page) || (page.nextOffset !== null && (page.nextOffset <= offset || !page.entries.length))) throw new TypeError('Invalid history page')
        if (!result) result = { ...page, entries: [], pageCount: 0, nextCursor: null }
        const before = ids.size
        for (const item of page.entries) if (!ids.has(item.id)) { ids.add(item.id); result.entries.push(item) }
        result.pageCount++; result.nextOffset = page.nextOffset; result.nextCursor = page.nextOffset === null ? null : String(page.nextOffset)
        if (!visitorId || page.nextOffset === null) break
        if (ids.size === before) throw new TypeError('History did not advance')
        offset = page.nextOffset
      }
      return result!
    }), value => validVisitHistory(value) && Number.isInteger((value as VisitHistoryWindow).pageCount) &&
      (value as VisitHistoryWindow).pageCount > 0 && (value as VisitHistoryWindow).pageCount <= value.entries.length + 1 &&
      (value as VisitHistoryWindow).nextCursor === (value.nextOffset === null ? null : String(value.nextOffset)))
  return entry
}
