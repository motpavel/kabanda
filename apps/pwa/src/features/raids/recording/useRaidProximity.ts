import { useCallback, useEffect, useRef, useState } from 'react'
import { getNearbyPoints } from '../../checkins/api'
import { getOneShotCoordinate } from '../../checkins/platform'
import type { NearbyPoint, OneShotCoordinate } from '../../checkins/types'
import { reportRaidPresence } from '../api'
import { readRaidMapCache } from './map-cache'
import { nearbyCachedPoints } from './proximity'

export type RaidProximityState = {
  status: 'locating' | 'ready' | 'offline' | 'blocked'
  coordinate: OneShotCoordinate | null
  nearby: NearbyPoint[]
  refresh: () => Promise<void>
}

export function useRaidProximity(identityId: string, raidId: string, enabled: boolean): RaidProximityState {
  const [status, setStatus] = useState<RaidProximityState['status']>(() => navigator.onLine ? 'locating' : 'offline')
  const [coordinate, setCoordinate] = useState<OneShotCoordinate | null>(null)
  const [nearby, setNearby] = useState<NearbyPoint[]>([])
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (!enabled || inFlight.current || document.visibilityState !== 'visible') return
    inFlight.current = true
    try {
      const nextCoordinate = await getOneShotCoordinate(10_000)
      setCoordinate(nextCoordinate)
      const cached = await readRaidMapCache(identityId, raidId).catch(() => null)
      setNearby(nearbyCachedPoints(cached?.points ?? [], nextCoordinate))
      if (!navigator.onLine) { setStatus('offline'); return }
      try {
        const response = await getNearbyPoints(
          raidId,
          nextCoordinate.latitude,
          nextCoordinate.longitude,
        )
        setNearby(response.points)
        setStatus('ready')
        if (nextCoordinate.accuracyMeters <= 50) {
          void reportRaidPresence(raidId, nextCoordinate).catch(() => undefined)
        }
      } catch { setStatus('offline') }
    } catch {
      setStatus('blocked')
    } finally {
      inFlight.current = false
    }
  }, [enabled, identityId, raidId])

  useEffect(() => {
    if (!enabled) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), 8_000)
    const resume = () => void refresh()
    window.addEventListener('online', resume)
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('online', resume)
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [enabled, refresh])

  return { status, coordinate, nearby, refresh }
}
