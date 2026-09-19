import { useEffect, useRef, useState } from 'react'
import { ApiError, requestJson } from '../../../lib/http'
import { offlineDb } from '../../offline/db'
import { getRaidMapPoints, getRaidSnapshot } from '../api'
import { useLiveRaid } from '../use-live-raid'
import type { RaidLiveSnapshot } from '../live-feed'
import type { RaidMapPoint, RouteTrackProjection } from '../types'
import { readRaidMapCache, saveRaidMapCache } from './map-cache'
import { RouteChangeBuffer, type RouteChangePage } from './route-changes'

export function useRaidMapData(identityId: string, raidId: string, live: boolean, completed: boolean) {
  const snapshot = useLiveRaid(identityId, raidId, live)
  const [staticSnapshot, setStaticSnapshot] = useState<RaidLiveSnapshot | null>(null)
  const [track, setTrack] = useState<RouteTrackProjection | null>(null)
  const [points, setPoints] = useState<RaidMapPoint[]>([])
  const [dataState, setDataState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const denied = useRef(false)
  const lastStored = useRef('')
  const currentData = live ? snapshot.data : staticSnapshot
  const dataRef = useRef(currentData)
  dataRef.current = currentData

  useEffect(() => {
    let active = true
    denied.current = false
    setTrack(null); setPoints([]); setStaticSnapshot(null); setDataState('loading'); lastStored.current = ''
    void readRaidMapCache(identityId, raidId).then(cached => {
      if (!active || !cached || denied.current) return
      setTrack(previous => previous ?? cached.track)
      setPoints(previous => previous.length ? previous : cached.points)
    }).catch(() => undefined)
    if (!live) void getRaidSnapshot(raidId).then(next => {
      if (!active) return
      setStaticSnapshot(next)
    }).catch(error => {
      if (!active) return
      setDataState('failed')
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        denied.current = true; setTrack(null); setPoints([])
        void offlineDb.raidMapCache.delete(JSON.stringify([identityId, raidId])).catch(() => undefined)
      }
    })
    return () => { active = false }
  }, [identityId, raidId, live, completed])

  useEffect(() => {
    if ((live && snapshot.denied) || currentData?.fieldVisible === false) {
      denied.current = true; setTrack(null); setPoints([]); setDataState('failed')
      void offlineDb.raidMapCache.delete(JSON.stringify([identityId, raidId])).catch(() => undefined)
      return
    }
    if (currentData?.raid.id === raidId) {
      denied.current = false
      if (currentData.points) setPoints(previous => JSON.stringify(previous) === JSON.stringify(currentData.points) ? previous : currentData.points!)
      if (currentData.track) setTrack(currentData.track)
      setDataState(live && snapshot.error ? 'failed' : 'ready')
    } else if (live && snapshot.error) setDataState('failed')
  }, [currentData, live, snapshot.error, snapshot.denied, identityId, raidId])

  const protocol = currentData?.teamVisits === true
  const legacyTrackPresent = Boolean(currentData?.track)
  const readable = Boolean(currentData && ['active', 'paused', 'finalizing', 'completed'].includes(currentData.raid.state) && currentData.fieldVisible !== false)
  useEffect(() => {
    if (legacyTrackPresent || !readable) return
    let active = true, inFlight = false
    let controller: AbortController | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const buffer = new RouteChangeBuffer()
    let legacyRevision: string | null = null
    const refresh = async () => {
      if (!active || inFlight || !navigator.onLine || document.visibilityState !== 'visible' || denied.current) return
      const value = dataRef.current
      if (!value) return
      inFlight = true
      controller = new AbortController()
      const signal = controller.signal
      const deadline = setTimeout(() => controller?.abort(), 30_000)
      try {
        let hasMore = false
        if (protocol) {
          // At most eight bounded pages per turn; catch-up yields before the
          // next turn. It does not occupy the lightweight visit/position read.
          for (let pageNumber = 0; pageNumber < 8 && active; pageNumber++) {
            const query = new URLSearchParams({ after: buffer.cursor })
            if (buffer.epoch) query.set('epoch', buffer.epoch)
            const page = await requestJson<RouteChangePage>(`/api/raids/${encodeURIComponent(raidId)}/route/changes?${query}`, { signal })
            if (!active || denied.current) return
            const projection = buffer.accept(page, raidId)
            hasMore = page.hasMore
            setTrack(previous => hasMore && previous && !previous.truncated && previous.pointCount > projection.pointCount ? previous : projection)
            setDataState('ready')
            if (!hasMore) break
          }
        } else {
          const revision = JSON.stringify([value.raid.state, value.raid.routeStatus.lastSampleAt, value.raid.routeStatus.acceptedSampleCount])
          if (revision !== legacyRevision) {
            const response = await requestJson<{ track: RouteTrackProjection }>(`/api/raids/${encodeURIComponent(raidId)}/route/track`, { signal })
            if (!active || denied.current) return
            if (!response.track || !Array.isArray(response.track.segments)) throw new TypeError('Invalid route')
            legacyRevision = revision
            setTrack(response.track); setDataState('ready')
          }
        }
        if (active && hasMore) timer = setTimeout(() => void refresh(), 250)
      } catch (error) {
        if (active) {
          setDataState('failed')
          if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
            denied.current = true; buffer.clear(); setTrack(null); setPoints([])
            void offlineDb.raidMapCache.delete(JSON.stringify([identityId, raidId])).catch(() => undefined)
          }
        }
      } finally {
        clearTimeout(deadline); inFlight = false; controller = null
      }
    }
    void refresh()
    const interval = setInterval(() => void refresh(), live ? 5000 : 30_000)
    const resume = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      active = false; controller?.abort(); clearInterval(interval); clearTimeout(timer)
      window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume)
    }
  }, [identityId, raidId, live, readable, protocol, legacyTrackPresent])

  useEffect(() => {
    if (currentData || live || completed) return
    let active = true
    void getRaidMapPoints(raidId).then(rows => { if (active && !denied.current) setPoints(rows) }).catch(() => undefined)
    return () => { active = false }
  }, [currentData, live, completed, raidId])
  useEffect(() => {
    if (!track || track.truncated || denied.current) return
    const signature = JSON.stringify([track.updatedAt, track.pointCount, track.segments, points])
    if (signature === lastStored.current) return
    lastStored.current = signature
    void saveRaidMapCache(identityId, raidId, points, track).catch(() => undefined)
  }, [identityId, raidId, track, points])
  return { track, points, dataState, positions: currentData?.positions,
    snapshotNavigator: currentData ? { userId: currentData.raid.navigatorUserId, sampleAt: currentData.raid.routeStatus.lastSampleAt } : null }
}
