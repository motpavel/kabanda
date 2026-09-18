import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { ReadCache } from '../../lib/read-cache'
import { ApiError, evictApiReads } from '../../lib/http'
import { subscribeConfirmedWrites } from '../../lib/api-events'
import { clearPrivateImageCache } from '../../lib/CachedImage'
import { offlineDb } from '../offline/db'
import { listRaidHistory, getKabandaProgress } from '../results/api'
import { listProgressHistory, isProgressHistoryPage } from '../results/history-api'
import { getPointProgress, isPointProgressPage, type PointProgressCategory, type PointProgressPage } from '../kabandas/point-progress'
import { readRaidHistory, readKabandaProgress, newestFirst } from '../results/cache'
import type { RaidHistoryFilter, RaidHistoryPage, KabandaProgress } from '../results/types'
import { getRaid, listActionableRaids } from './api'
import { actionableStates, isRaidProjection, raidReadDb, raidReadKey, readSnapshot, readRaidProjection, saveRaidProjection, writeSnapshot } from './cache'
import { useVisibleRead } from './read-refresh'
import type { RaidProjection } from './types'
import type { ProductionResourceState } from './production-model'

type State<T> = { data: T | null; status: ProductionResourceState; message: string | null; savedAt: string | null }
type Kind = 'actionable' | 'raid' | 'history' | 'progress' | 'point-progress'
type KabandaRole = 'owner' | 'member'
const entries = new Map<string, RaidResource<unknown>>()
const deniedTeams = new Set<string>()
// First-time detail reads do not know their team until the response arrives.
// Keep the latest denial epoch even after a later read restores access, so an
// older unbound response cannot undo that decision or repopulate private caches.
let revocationEpoch = 0
const teamRevocationEpochs = new Map<string, number>()
const teamKey = (identityId: string, kabandaId: string) => JSON.stringify([identityId, kabandaId])
const online = () => typeof navigator === 'undefined' || navigator.onLine
const actionableMembership = (raid: RaidProjection, identityId: string, role?: KabandaRole): boolean | null => {
  if (!actionableStates.has(raid.state)) return false
  if (role === 'owner') return true
  if (role !== 'member') return null
  return raid.participants.some(participant => participant.id === identityId &&
    ['invited', 'accepted', 'ready', 'active'].includes(participant.state))
}

/** Session resource shared by mounted, hidden and returning screens. ReadCache's
 * generation fences network, hydration and queued disk writes, including equal versions. */
export class RaidResource<T> {
  state: State<T> = { data: null, status: 'loading', message: null, savedAt: null }
  private listeners = new Set<() => void>()
  private activeReaders = 0
  private reads = new ReadCache()
  private pending: Promise<void> | null = null
  private hydrated = false
  private retired = false
  private writes: Promise<unknown> = Promise.resolve()
  constructor(readonly identityId: string, public kabandaId: string, readonly kind: Kind,
    readonly id: string, readonly key: string, private load: () => Promise<T>, public kabandaRole?: KabandaRole) {}
  registerKabandaRole(role?: KabandaRole) { if (role) this.kabandaRole = role }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.state
  retainActiveReader = () => {
    this.activeReaders += 1
    let released = false
    return () => { if (!released) { released = true; this.activeReaders -= 1 } }
  }
  refreshIfVisible() {
    if (this.activeReaders > 0 && online() &&
      (typeof document === 'undefined' || document.visibilityState === 'visible')) void this.refresh()
  }
  revalidateSession() {
    if (this.retired) return
    // A new session for the SAME identity may have different permissions. Keep
    // subscribed resource objects, but fence old replies and mark data unverified.
    // Retiring these objects would strand useMemo/useSyncExternalStore consumers
    // on a permanently loading entry until a full document reload.
    this.invalidate(false)
    this.refreshIfVisible()
  }
  private set(state: State<T>) { this.state = state; for (const listener of this.listeners) listener() }
  private persist(value: T, current: () => boolean) {
    this.writes = this.writes.catch(() => undefined).then(async () => {
      if (!current()) return
      await writeSnapshot({ key: this.key, identityId: this.identityId, kabandaId: this.kabandaId,
        value, savedAt: new Date().toISOString() }, current)
      if (this.kind === 'raid' && isRaidProjection(value)) await saveRaidProjection(this.identityId, value, current)
      if (this.kind === 'actionable' && Array.isArray(value)) {
        for (const raid of value) if (isRaidProjection(raid) && current()) await saveRaidProjection(this.identityId, raid, current)
      }
    }).catch(async () => {
      // Do not leave an older list behind after a quota error. Deletion frees space.
      if (current()) await raidReadDb.snapshots.delete(this.key).catch(() => undefined)
    })
  }
  accept(value: T, persist = true, status: ProductionResourceState = 'ready') {
    if (this.retired) return
    const owner = this.kind === 'raid' && isRaidProjection(value) ? value.kabandaId : this.kabandaId
    if (owner && deniedTeams.has(teamKey(this.identityId, owner))) {
      this.kabandaId = owner
      this.deny()
      return
    }
    if (this.kind === 'raid' && isRaidProjection(value) && isRaidProjection(this.state.data) && this.state.data.version > value.version) return
    this.reads.invalidate()
    this.pending = null
    this.hydrated = true
    if (this.kind === 'raid' && isRaidProjection(value)) this.kabandaId = value.kabandaId
    this.set({ data: value, status, message: null, savedAt: null })
    if (persist) this.persist(value, this.reads.fence())
  }
  retire() {
    this.retired = true
    this.reads.invalidate()
    this.set({ data: null, status: 'loading', message: null, savedAt: null })
  }
  invalidate(discardDisk = true) {
    this.reads.invalidate()
    this.pending = null
    this.hydrated = true
    this.set({ ...this.state, status: this.state.data === null ? 'loading' : 'stale', message: null })
    // A previous page of history/statistics is now known to be obsolete.
    if (discardDisk) this.writes = this.writes.catch(() => undefined).then(async () => {
      await raidReadDb.snapshots.delete(this.key)
      const key = JSON.stringify([this.identityId, this.kabandaId])
      if (this.kind === 'history') await offlineDb.raidHistory.delete(key)
      if (this.kind === 'progress') await offlineDb.kabandaProgress.delete(key)
    }).catch(() => undefined)
  }
  deny() {
    this.reads.invalidate()
    this.pending = null
    this.hydrated = true
    this.set({ data: null, status: 'access-error', savedAt: null, message: 'Доступ отозван или ресурс недоступен.' })
    this.writes = this.writes.catch(() => undefined).then(async () => {
      await raidReadDb.snapshots.delete(this.key)
      if (this.kind === 'raid') {
        const key = JSON.stringify([this.identityId, this.id])
        await Promise.all([offlineDb.raidProjections.delete(key), offlineDb.raidMapCache.delete(key), offlineDb.raidResults.delete(key)])
      }
    }).catch(() => undefined)
  }
  async hydrate() {
    if (this.hydrated || this.state.status === 'access-error') return
    this.hydrated = true
    const current = this.reads.fence()
    try {
      const cached = await readSnapshot(this.identityId, this.key)
      let value = cached?.value
      let savedAt = cached?.savedAt
      if (!cached && this.kind === 'raid') {
        const legacy = await readRaidProjection(this.identityId, this.id)
        value = legacy?.raid; savedAt = legacy?.savedAt
      }
      // The old history cache only had the first 12-result page. Do not apply
      // that page to another limit, cursor or filter.
      if (!cached && this.kind === 'history' && this.key === raidReadKey(this.identityId, this.kabandaId, 'history', { limit: 12, cursor: null })) {
        const legacy = await readRaidHistory(this.identityId, this.kabandaId)
        value = legacy?.page; savedAt = legacy?.savedAt
      }
      if (!cached && this.kind === 'progress') {
        const legacy = await readKabandaProgress(this.identityId, this.kabandaId)
        value = legacy?.progress; savedAt = legacy?.savedAt
      }
      if (!current() || this.state.data !== null) return
      if (this.kind === 'raid' && isRaidProjection(value)) this.kabandaId = value.kabandaId
      if (deniedTeams.has(teamKey(this.identityId, this.kabandaId))) { this.deny(); return }
      if (validSnapshot(this.kind, value, this.key) && savedAt) this.set({ data: value as T, status: 'stale',
        message: this.state.message ?? (online() ? null : 'Нет соединения. Показана сохранённая копия.'), savedAt })
      else if (!online()) this.set({ ...this.state, status: 'error', message: 'Нет соединения и сохранённой копии.' })
    } catch { if (current() && !online()) this.set({ ...this.state, status: 'error', message: 'Не удалось прочитать сохранённую копию.' }) }
  }
  refresh = (): Promise<void> => {
    if (this.retired) return Promise.resolve()
    if (this.pending) return this.pending
    const current = this.reads.fence()
    const startedRevocationEpoch = revocationEpoch
    const pending = this.reads.read(this.key, this.load).then(value => {
      if (!current()) return
      const owner = this.kind === 'raid' && isRaidProjection(value) ? value.kabandaId : this.kabandaId
      if (owner && (teamRevocationEpochs.get(teamKey(this.identityId, owner)) ?? 0) > startedRevocationEpoch) {
        this.kabandaId = owner
        this.deny()
        return
      }
      // Only a read started after the last denial can confirm restored access.
      if (owner) deniedTeams.delete(teamKey(this.identityId, owner))
      const previous = this.state.data
      this.accept(value)
      if (this.kind === 'raid' && isRaidProjection(value)) publishRaid(this.identityId, value, this, true, isRaidProjection(previous) ? previous : null)
      if (this.kind === 'actionable' && Array.isArray(value)) {
        const ids = new Set(value.filter(isRaidProjection).map(raid => raid.id))
        for (const entry of entries.values()) if (entry.identityId === this.identityId && entry.kabandaId === this.kabandaId && entry.kind === 'raid' && !ids.has(entry.id)) {
          // Absence is not completion or revocation: keep safe viewing, recheck permissions.
          entry.invalidate(false)
        }
        for (const raid of value) if (isRaidProjection(raid)) publishRaid(this.identityId, raid, this, false)
      }
    }).catch(async (reason: unknown) => {
      if (!current()) return
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) {
        if (this.kind === 'raid') { this.deny(); clearPrivateImageCache(); await removeFromLists(this.identityId, this.id) }
        else await revokeTeam(this.identityId, this.kabandaId)
        return
      }
      await this.hydrate()
      if (!current() || this.state.status === 'access-error') return
      this.set({ ...this.state, status: this.state.data === null ? 'error' : 'stale',
        message: online() ? 'Не удалось обновить данные.' : 'Нет соединения. Показана сохранённая копия.' })
    }).finally(() => { if (this.pending === pending) this.pending = null })
    this.pending = pending
    return pending
  }
  settled = () => this.writes
}

function validSnapshot(kind: Kind, value: unknown, key: string): boolean {
  if (kind === 'raid') return isRaidProjection(value)
  if (kind === 'actionable') return Array.isArray(value) && value.every(isRaidProjection)
  if (kind === 'point-progress') return isPointProgressPage(value)
  if (!value || typeof value !== 'object') return false
  if (kind === 'history') {
    const params = JSON.parse(key)[3] as { filter?: RaidHistoryFilter } | null
    if (params?.filter) return isProgressHistoryPage(value, params.filter)
    const page = value as RaidHistoryPage
    return Array.isArray(page.raids) && newestFirst(page).raids.length === page.raids.length
  }
  const progress = value as KabandaProgress
  return [progress.personal, progress.team].every(metrics => metrics &&
    ['completedRaids', 'distanceMeters', 'durationSeconds', 'uniquePoints', 'photos'].every(field =>
      Number.isFinite(metrics[field as keyof typeof metrics]) && metrics[field as keyof typeof metrics] >= 0))
}

function resource<T>(identityId: string, kabandaId: string, kind: Kind, id: string, params: unknown, load: () => Promise<T>) {
  const key = raidReadKey(identityId, kind === 'raid' ? id : kabandaId, kind, params)
  let entry = entries.get(key)
  if (!entry) {
    entry = new RaidResource(identityId, kabandaId, kind, id, key, load)
    entries.set(key, entry)
    if (deniedTeams.has(teamKey(identityId, kabandaId))) entry.deny()
  }
  return entry as RaidResource<T>
}
export const actionableResource = (identityId: string, kabandaId: string, role?: KabandaRole) => {
  const entry = resource<RaidProjection[]>(identityId, kabandaId, 'actionable', kabandaId, null, () => listActionableRaids(kabandaId))
  entry.registerKabandaRole(role)
  return entry
}
export const raidResource = (identityId: string, raidId: string) =>
  resource(identityId, '', 'raid', raidId, null, () => getRaid(raidId))
export const historyResource = (identityId: string, kabandaId: string, limit = 12, cursor?: string) =>
  resource<RaidHistoryPage>(identityId, kabandaId, 'history', kabandaId, { limit, cursor: cursor ?? null }, () => listRaidHistory(kabandaId, limit, cursor))
export const historyPageResource = (identityId: string, kabandaId: string, filter: RaidHistoryFilter, cursor?: string) =>
  resource<RaidHistoryPage>(identityId, kabandaId, 'history', kabandaId, { limit: 12, cursor: cursor ?? null, filter, api: 'participation-v1' }, () => listProgressHistory(kabandaId, filter, 12, cursor))
export const progressResource = (identityId: string, kabandaId: string) =>
  resource<KabandaProgress>(identityId, kabandaId, 'progress', kabandaId, null, () => getKabandaProgress(kabandaId))
export const pointProgressResource = (identityId: string, kabandaId: string, category: PointProgressCategory, pointIds: readonly string[] = []) => {
  const ids = category === 'stores' ? [] : [...new Set(pointIds)].sort()
  return resource<PointProgressPage>(identityId, kabandaId, 'point-progress', kabandaId, { category, ids }, () => getPointProgress(kabandaId, category, ids))
}

async function removeFromLists(identityId: string, raidId: string) {
  for (const entry of entries.values()) if (entry.identityId === identityId && entry.kind === 'actionable' && Array.isArray(entry.state.data)) {
    entry.accept(entry.state.data.filter((raid: RaidProjection) => raid.id !== raidId), true, entry.state.status)
  }
  await raidReadDb.transaction('rw', raidReadDb.snapshots, async () => {
    const records = await raidReadDb.snapshots.where('identityId').equals(identityId).toArray()
    for (const record of records) {
      if (JSON.parse(record.key)[2] === 'actionable' && Array.isArray(record.value)) {
        const next = record.value.filter((raid: RaidProjection) => raid.id !== raidId)
        if (next.length !== record.value.length) await raidReadDb.snapshots.put({ ...record, value: next })
      }
    }
  }).catch(() => undefined)
}
function publishRaid(identityId: string, raid: RaidProjection, source?: RaidResource<unknown>, updateLists = true, prior?: RaidProjection | null) {
  if (deniedTeams.has(teamKey(identityId, raid.kabandaId))) return
  const detail = raidResource(identityId, raid.id)
  if (updateLists) actionableResource(identityId, raid.kabandaId)
  const previous = prior === undefined ? detail.state.data : prior
  // Commands and reads may arrive with equal lifecycle versions but newer readiness.
  if (previous && previous.version > raid.version) return
  if (detail !== source) detail.accept(raid)
  const changed = !source || !previous || JSON.stringify([previous.state, previous.version, previous.allowedActions, previous.participants, previous.navigatorReady, previous.navigatorUserId]) !==
    JSON.stringify([raid.state, raid.version, raid.allowedActions, raid.participants, raid.navigatorReady, raid.navigatorUserId])
  if (updateLists && changed) evictApiReads(path => path.startsWith(`/api/kabandas/${raid.kabandaId}/raids`) || path.startsWith(`/api/kabandas/${raid.kabandaId}/progress`) || path.startsWith(`/api/raids/${raid.id}/`))
  if (updateLists && changed && raid.state === 'completed' && previous?.state !== 'completed') {
    historyResource(identityId, raid.kabandaId)
    progressResource(identityId, raid.kabandaId)
    invalidatePointProgress(identityId, raid.kabandaId)
  }
  if (updateLists && changed) for (const entry of entries.values()) {
    if (entry === source || entry.identityId !== identityId || entry.kabandaId !== raid.kabandaId) continue
    if (entry.kind === 'actionable') {
      const list = entry.state.data as RaidProjection[] | null
      if (!list) entry.invalidate()
      if (list) {
        const membership = actionableMembership(raid, identityId, entry.kabandaRole)
        if (membership === null) {
          // Without the team role we cannot reproduce the server's owner visibility.
          // Apply the confirmed card in memory, discard list membership on disk, revalidate.
          entry.accept(list.map(item => item.id === raid.id ? raid : item), false, entry.state.status)
          entry.invalidate()
        } else {
          const next = list.flatMap(item => item.id !== raid.id ? [item] : membership ? [raid] : [])
          // A confirmed command can establish new membership (e.g. accept via
          // a direct link) before list revalidation finishes. Do not invent a
          // full list when it is unknown, or reinsert absent cards from reads.
          if (!source && membership && !next.some(item => item.id === raid.id)) next.push(raid)
          entry.accept(next, true, entry.state.status)
        }
      }
    }
    if ((entry.kind === 'history' || entry.kind === 'progress') &&
      raid.state === 'completed' && previous?.state !== 'completed') {
      entry.invalidate()
      if (online()) void entry.refresh()
    }
  }
}
async function revokeTeam(identityId: string, kabandaId: string) {
  const key = teamKey(identityId, kabandaId)
  teamRevocationEpochs.set(key, ++revocationEpoch)
  deniedTeams.add(key)
  for (const entry of entries.values()) if (entry.identityId === identityId && entry.kabandaId === kabandaId) entry.deny()
  clearPrivateImageCache()
  // Only read models and private images: never touch operational queues.
  await offlineDb.transaction('rw', offlineDb.raidProjections, offlineDb.raidMapCache, async () => {
    const cards = await offlineDb.raidProjections.where('identityId').equals(identityId).filter(row => row.kabandaId === kabandaId).toArray()
    await offlineDb.raidMapCache.bulkDelete(cards.map(card => card.key))
    await offlineDb.raidProjections.bulkDelete(cards.map(card => card.key))
  }).catch(() => undefined)
  await Promise.all([
    raidReadDb.snapshots.where('[identityId+kabandaId]').equals([identityId, kabandaId]).delete(),
    offlineDb.raidHistory.where('[identityId+kabandaId]').equals([identityId, kabandaId]).delete(),
    offlineDb.kabandaProgress.where('[identityId+kabandaId]').equals([identityId, kabandaId]).delete(),
    offlineDb.raidResults.where('identityId').equals(identityId).filter(row => row.kabandaId === kabandaId).delete(),
  ]).catch(() => undefined)
}

function invalidatePointProgress(identityId: string, kabandaId?: string) {
  // Invalidate persisted views even when this document has not opened the map.
  // Operational outboxes live in another database and are never touched here.
  void raidReadDb.transaction('rw', raidReadDb.snapshots, async () => {
    const rows = await raidReadDb.snapshots.where('identityId').equals(identityId).toArray()
    await raidReadDb.snapshots.bulkDelete(rows.filter(row => (!kabandaId || row.kabandaId === kabandaId) &&
      JSON.parse(row.key)[2] === 'point-progress').map(row => row.key))
  }).catch(() => undefined)
  for (const entry of entries.values()) if (entry.identityId === identityId && entry.kind === 'point-progress' && (!kabandaId || entry.kabandaId === kabandaId)) {
    entry.invalidate()
    entry.refreshIfVisible()
  }
}

subscribeConfirmedWrites(event => {
  if (!event.identityId) return
  const membership = /^\/api\/kabandas\/([^/]+)\/members\/([^/]+)$/.exec(event.path)
  if (membership) {
    if (membership[2] === 'me' || membership[2] === event.identityId) void revokeTeam(event.identityId, membership[1]!)
    else for (const entry of entries.values()) if (entry.identityId === event.identityId && entry.kabandaId === membership[1]) {
      entry.invalidate()
      if (online()) void entry.refresh()
    }
  }
  const pointWrite = /^\/api\/raids\/([^/]+)\/check-in(?:s|-(?:claims|fallbacks))(?:\/|$)/.exec(event.path)
  if (pointWrite) {
    const raidId = pointWrite[1]!
    const owner = entries.get(raidReadKey(event.identityId, raidId, 'raid'))?.kabandaId
    invalidatePointProgress(event.identityId, owner || undefined)
  }
  if (!event.body || typeof event.body !== 'object') return
  const raid = (event.body as { raid?: unknown }).raid
  // Presence samples and route batches intentionally do not trigger list/history reloads.
  if (!isRaidProjection(raid)) return
  publishRaid(event.identityId, raid)
  if (/\/kabandas\/[^/]+\/raids$/.test(event.path)) {
    const list = actionableResource(event.identityId, raid.kabandaId)
    // The command proves this raid exists, not the membership of the rest of a list.
    if (actionableMembership(raid, event.identityId, list.kabandaRole) === true && list.state.data && !list.state.data.some(item => item.id === raid.id)) {
      list.accept([...list.state.data, raid], true, list.state.status)
    }
  }
  if (/\/(?:commands|participants|finalization)\//.test(event.path) || /\/kabandas\/[^/]+\/raids$/.test(event.path)) {
    const list = actionableResource(event.identityId, raid.kabandaId)
    // Revalidate exact membership (owner visibility and the server's limit remain authoritative).
    if (online()) void list.refresh()
  }
})

/** Same-account session rotation is not an identity switch. Existing mounted
 * consumers retain their entries; permissions are confirmed again by the API. */
export function revalidateRaidSession(identityId: string) {
  for (const entry of entries.values()) if (entry.identityId === identityId) entry.revalidateSession()
}

/** Without an identity, retire everything. Otherwise retain matching objects,
 * including offline-mounted consumers, but invalidate their permission state.
 * This does not activate an identity or authorize a command: only a fresh API
 * response can make them ready. Other identities are retired immediately. */
export function resetRaidResources(retainedIdentity?: string) {
  for (const [key, entry] of entries) {
    if (retainedIdentity && entry.identityId === retainedIdentity) entry.revalidateSession()
    else { entry.retire(); entries.delete(key) }
  }
  for (const key of deniedTeams) if (JSON.parse(key)[0] !== retainedIdentity) deniedTeams.delete(key)
  for (const key of teamRevocationEpochs.keys()) if (JSON.parse(key)[0] !== retainedIdentity) teamRevocationEpochs.delete(key)
}

if (typeof window !== 'undefined') {
  let identity: string | null | undefined
  window.addEventListener('storage', event => {
    if (event.key !== null && event.key !== 'kabanda:relay-session:v1') return
    let retainedIdentity: string | undefined
    try {
      const saved = JSON.parse(event.newValue ?? 'null') as { opaque?: unknown; identityId?: unknown } | null
      if (saved && typeof saved.opaque === 'string' && saved.opaque.length > 0 &&
        saved.opaque.length <= 32_768 && typeof saved.identityId === 'string') retainedIdentity = saved.identityId
    } catch { /* Cleared, corrupt and anonymous sessions drop all old views. */ }
    // Also works before the first /me reply after an offline document reload.
    resetRaidResources(retainedIdentity)
  })
  window.addEventListener('kabanda:identity-changed', event => {
    const next = (event as CustomEvent<{ userId: string | null }>).detail.userId
    if (next === identity) return
    identity = next
    resetRaidResources(next ?? undefined)
  })
}

export function useRaidResource<T>(entry: RaidResource<T>, active: boolean, interval: number | null) {
  const state = useSyncExternalStore(entry.subscribe, entry.snapshot, entry.snapshot)
  useEffect(() => active ? entry.retainActiveReader() : undefined, [active, entry])
  useEffect(() => { void entry.hydrate() }, [entry])
  const refresh = useVisibleRead(entry.refresh, entry.key, active, interval)
  return { ...state, refresh }
}
export function useActionableRaids(identityId: string, kabandaId: string, role: KabandaRole, active = true) {
  const entry = useMemo(() => actionableResource(identityId, kabandaId, role), [identityId, kabandaId, role])
  return useRaidResource(entry, active, 10_000)
}
export function useRaidHistory(identityId: string, kabandaId: string, active = true) {
  const entry = useMemo(() => historyResource(identityId, kabandaId), [identityId, kabandaId])
  return useRaidResource(entry, active, 60_000)
}
export function useKabandaProgress(identityId: string, kabandaId: string, active = true) {
  const entry = useMemo(() => progressResource(identityId, kabandaId), [identityId, kabandaId])
  return useRaidResource(entry, active, 60_000)
}
export function usePointProgress(identityId: string, kabandaId: string, category: PointProgressCategory, pointIds: readonly string[], active = true) {
  const idsKey = JSON.stringify(category === 'stores' ? [] : [...new Set(pointIds)].sort())
  const entry = useMemo(() => pointProgressResource(identityId, kabandaId, category, JSON.parse(idsKey) as string[]), [identityId, kabandaId, category, idsKey])
  return useRaidResource(entry, active && (category === 'stores' || pointIds.length > 0), 30_000)
}
