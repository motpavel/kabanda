import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../../../lib/http'
import { requestRouteLease } from '../api'
import type { RaidProjection, RouteStatusProjection } from '../types'
import { replayRouteBatch } from './replay'
import { deriveRecorderPhase, isPersistedSampleFresh } from './state'
import {
  acquireWriterLease,
  completeRouteLeaseAttempt,
  findRecorderSession,
  getOrCreateRouteLeaseAttempt,
  getOrCreateRecorderSession,
  getRecorderLocalStats,
  persistRouteSample,
  releaseWriterLease,
  renewWriterLease,
  setRecorderWanted,
  WRITER_LEASE_RENEW_MS,
} from './store'
import type {
  RecorderContext,
  RecorderLocalStats,
  RecorderPhase,
  RouteRecorderView,
  WakeLockPhase,
  WriterFence,
} from './types'
import { useRecordingRuntime } from './runtime'

const emptyStats: RecorderLocalStats = {
  pendingCount: 0,
  preliminaryDistanceM: 0,
  lastPersistedSampleAt: null,
}

function fallbackRouteStatus(raid: RaidProjection | null): RouteStatusProjection {
  if (raid?.routeStatus) return raid.routeStatus
  return { status: 'awaiting_lease', lastSampleAt: null, lastReceivedAt: null, acceptedSampleCount: 0, missingSequenceCount: 0 }
}

function getTabId(): string {
  const key = 'kabanda:route-recorder-tab:v1'
  try {
    const current = sessionStorage.getItem(key)
    if (current) return current
    const created = crypto.randomUUID()
    sessionStorage.setItem(key, created)
    return created
  } catch {
    return crypto.randomUUID()
  }
}

export function useRouteRecorder(input: {
  identityId: string
  raid: RaidProjection
  staleProjection: boolean
  onCanonicalRefresh: () => Promise<unknown>
  onApplyRaid: (raid: RaidProjection) => Promise<unknown>
}): RouteRecorderView {
  const { identityId, raid, staleProjection, onCanonicalRefresh, onApplyRaid } = input
  const [phase, setPhase] = useState<RecorderPhase>(raid.state === 'paused' ? 'paused' : 'recovering')
  const [wakeLock, setWakeLock] = useState<WakeLockPhase>('released')
  const [stats, setStats] = useState<RecorderLocalStats>(emptyStats)
  const [routeStatus, setRouteStatus] = useState<RouteStatusProjection>(() => fallbackRouteStatus(raid))
  const [message, setMessage] = useState<string | null>(null)
  const [recoverNonce, setRecoverNonce] = useState(0)
  const leaseRequestInFlight = useRef(false)
  const flushRef = useRef<() => Promise<void>>(async () => undefined)
  const previousContext = useRef<RecorderContext | null>(null)
  const { setPhase: setRuntimePhase } = useRecordingRuntime()
  const tabId = useRef(getTabId()).current

  const context = useMemo<RecorderContext | null>(() => {
    if (!raid.navigatorLease) return null
    return {
      identityId,
      kabandaId: raid.kabandaId,
      raidId: raid.id,
      navigatorLeaseId: raid.navigatorLease.id,
      leaseGeneration: raid.navigatorLease.generation,
    }
  }, [identityId, raid.id, raid.kabandaId, raid.navigatorLease])
  const contextKey = context
    ? `${context.identityId}:${context.raidId}:${context.navigatorLeaseId}:${context.leaseGeneration}`
    : 'none'
  const eligible = Boolean(
    context &&
    raid.state === 'active' &&
    raid.navigatorUserId === identityId &&
    !staleProjection,
  )

  const canRequestServerLease = raid.state === 'active' && raid.navigatorUserId === identityId &&
    !staleProjection && navigator.onLine

  const requestServerLease = useCallback(async (action: 'acquire' | 'recover') => {
    if (!canRequestServerLease || leaseRequestInFlight.current) return false
    leaseRequestInFlight.current = true
    setPhase('recovering')
    setMessage(null)
    try {
      const attempt = await getOrCreateRouteLeaseAttempt(
        identityId,
        raid.kabandaId,
        raid.id,
        action,
        raid.version,
      )
      if (!attempt) return false
      const response = await requestRouteLease(
        raid.id,
        action,
        raid.version,
        attempt.clientInstanceId,
        attempt.idempotencyKey,
      )
      if (response.raid.navigatorLease) {
        await getOrCreateRecorderSession({
          identityId,
          kabandaId: response.raid.kabandaId,
          raidId: response.raid.id,
          navigatorLeaseId: response.raid.navigatorLease.id,
          leaseGeneration: response.raid.navigatorLease.generation,
        })
      }
      await completeRouteLeaseAttempt(identityId, raid.id, attempt.fingerprint)
      await onApplyRaid(response.raid)
      return true
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NAVIGATOR_LEASE_HELD') {
        setPhase('standby')
        setMessage('Маршрут уже пишет другое устройство. Восстановление здесь завершит его lease.')
      } else {
        setPhase('error')
        setMessage(error instanceof ApiError ? error.message : 'Не удалось подтвердить lease навигатора.')
      }
      return false
    } finally {
      leaseRequestInFlight.current = false
    }
  }, [canRequestServerLease, identityId, onApplyRaid, raid.id, raid.kabandaId, raid.version])

  useEffect(() => {
    if (canRequestServerLease && !raid.navigatorLease) void requestServerLease('acquire')
  }, [canRequestServerLease, raid.navigatorLease, requestServerLease])

  useEffect(() => {
    setRouteStatus(fallbackRouteStatus(raid))
  }, [raid.routeStatus])

  useEffect(() => {
    setRuntimePhase(phase)
  }, [phase, setRuntimePhase])

  useEffect(() => () => setRuntimePhase('ineligible'), [setRuntimePhase])

  useEffect(() => {
    const previous = previousContext.current
    if (previous && (!context || !(
      previous.identityId === context.identityId &&
      previous.raidId === context.raidId &&
      previous.navigatorLeaseId === context.navigatorLeaseId &&
      previous.leaseGeneration === context.leaseGeneration
    ))) void setRecorderWanted(previous, false)
    if (context) previousContext.current = context
    if (raid.state === 'active') return
    if (previous) void setRecorderWanted(previous, false)
  }, [contextKey, raid.state])

  useEffect(() => {
    if (!eligible || !context) {
      setPhase(raid.state === 'paused' ? 'paused' : 'ineligible')
      setStats(emptyStats)
      flushRef.current = async () => undefined
      return
    }

    let cancelled = false
    let fence: WriterFence | null = null
    let watchId: number | null = null
    let wakeSentinel: WakeLockSentinel | null = null
    let starting = false
    let replaying = false
    let blocked = false
    let failed = false
    let recovering = true
    let lastPersistedSampleAt: string | null = null

    const safeSetPhase = (next: RecorderPhase) => {
      if (!cancelled) setPhase(next)
    }
    const refreshStats = async () => {
      const next = await getRecorderLocalStats(context)
      if (cancelled) return next
      lastPersistedSampleAt = next.lastPersistedSampleAt
      setStats(next)
      return next
    }
    const updateDerivedPhase = () => {
      safeSetPhase(deriveRecorderPhase({
        eligible: true,
        paused: false,
        visible: document.visibilityState === 'visible',
        ownsWriterLease: Boolean(fence),
        watchActive: watchId !== null,
        lastPersistedSampleAt,
        blocked,
        failed,
        recovering,
      }))
    }
    const stopWatch = () => {
      if (watchId !== null) navigator.geolocation?.clearWatch(watchId)
      watchId = null
    }
    const releaseWakeLock = async () => {
      const current = wakeSentinel
      wakeSentinel = null
      if (current && !current.released) await current.release().catch(() => undefined)
      if (!cancelled) setWakeLock('released')
    }
    const releaseLocalWriter = async () => {
      const current = fence
      fence = null
      if (current) await releaseWriterLease(current)
    }
    const stopPageRecorder = async (releaseWriter: boolean) => {
      stopWatch()
      await releaseWakeLock()
      if (releaseWriter) await releaseLocalWriter()
    }
    const requestWakeLock = async () => {
      if (!('wakeLock' in navigator)) {
        if (!cancelled) setWakeLock('unsupported')
        return
      }
      if (!cancelled) setWakeLock('requesting')
      try {
        const sentinel = await navigator.wakeLock.request('screen')
        if (cancelled || document.visibilityState !== 'visible') {
          await sentinel.release().catch(() => undefined)
          return
        }
        wakeSentinel = sentinel
        setWakeLock('held')
        sentinel.addEventListener('release', () => {
          if (wakeSentinel === sentinel) wakeSentinel = null
          if (!cancelled) setWakeLock('released')
        })
      } catch {
        if (!cancelled) setWakeLock('failed')
      }
    }
    const flush = async () => {
      if (cancelled || replaying || !fence || !navigator.onLine) return
      replaying = true
      try {
        for (let count = 0; count < 3 && fence && !cancelled; count += 1) {
          const result = await replayRouteBatch(context, fence)
          if (result.kind === 'accepted') {
            setRouteStatus(result.routeStatus)
            await refreshStats()
            continue
          }
          if (result.kind === 'terminal') {
            failed = true
            setMessage(result.authRequired
              ? 'Сессия истекла. Локальные точки сохранены; войдите снова для безопасного replay.'
              : 'Сервер завершил lease навигатора. Запись остановлена, состояние рейда обновляется.')
            await stopPageRecorder(true)
            updateDerivedPhase()
            if (result.authRequired) {
              window.location.reload()
              return
            }
            await onCanonicalRefresh()
          } else if (result.kind === 'fence-lost') {
            fence = null
            await stopPageRecorder(false)
            updateDerivedPhase()
          }
          break
        }
      } finally {
        replaying = false
      }
    }
    flushRef.current = flush

    const startPageRecorder = async () => {
      if (cancelled || starting || document.visibilityState !== 'visible') return
      if (fence && watchId !== null) return
      starting = true
      blocked = false
      failed = false
      recovering = true
      safeSetPhase('recovering')
      try {
        const previousSession = await findRecorderSession(context.identityId, context.raidId)
        const matchesServerLease = previousSession &&
          previousSession.navigatorLeaseId === context.navigatorLeaseId &&
          previousSession.leaseGeneration === context.leaseGeneration
        if (!matchesServerLease) {
          await requestServerLease('acquire')
          return
        }
        const session = await getOrCreateRecorderSession(context)
        if (!session || cancelled) return
        const acquired = await acquireWriterLease(context, tabId)
        if (!acquired || cancelled) {
          safeSetPhase('standby')
          return
        }
        fence = acquired
        await refreshStats()
        await requestWakeLock()
        if (!navigator.geolocation) {
          blocked = true
          setMessage('Geolocation API недоступен. Маршрут не записывается.')
          await stopPageRecorder(true)
          updateDerivedPhase()
          return
        }
        if (cancelled || document.visibilityState !== 'visible') return
        watchId = navigator.geolocation.watchPosition(
          (position) => {
            const callbackFence = fence
            if (!callbackFence || cancelled) return
            void persistRouteSample(
              context,
              callbackFence,
              {
                capturedAt: new Date(position.timestamp).toISOString(),
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracyM: position.coords.accuracy,
                speedMps: Number.isFinite(position.coords.speed) ? position.coords.speed : null,
                headingDeg: Number.isFinite(position.coords.heading) ? position.coords.heading : null,
              },
            ).then(async (record) => {
              if (cancelled) return
              if (!record) {
                fence = null
                await stopPageRecorder(false)
                safeSetPhase('standby')
                return
              }
              if (
                !fence ||
                fence.writerGeneration !== callbackFence.writerGeneration ||
                fence.fenceToken !== callbackFence.fenceToken ||
                watchId === null ||
                document.visibilityState !== 'visible'
              ) return
              recovering = false
              lastPersistedSampleAt = record.capturedAt
              const nextStats = await refreshStats()
              safeSetPhase(isPersistedSampleFresh(record.capturedAt) ? 'fresh' : 'stale')
              if (nextStats.pendingCount >= 20) await flush()
            }).catch(() => {
              if (cancelled) return
              recovering = false
              failed = true
              setMessage('Не удалось сохранить GPS в памяти устройства. Запись остановлена без потери уже сохранённых точек.')
              void stopPageRecorder(true).then(updateDerivedPhase)
            })
          },
          (error) => {
            if (cancelled) return
            recovering = false
            blocked = error.code === error.PERMISSION_DENIED
            failed = !blocked
            setMessage(blocked
              ? 'Доступ к геолокации запрещён. Разрешите его в настройках браузера.'
              : `GPS остановился: ${error.message || 'неизвестная ошибка'}`)
            void stopPageRecorder(true).then(updateDerivedPhase)
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
        )
        recovering = false
        updateDerivedPhase()
        void flush()
      } finally {
        starting = false
      }
    }

    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') {
        void stopPageRecorder(true).then(updateDerivedPhase)
      } else {
        void startPageRecorder()
        void flush()
      }
    }
    const handleResume = () => {
      if (document.visibilityState === 'visible') {
        void startPageRecorder()
        void flush()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('online', handleResume)
    window.addEventListener('focus', handleResume)
    window.addEventListener('pageshow', handleResume)

    const leaseTimer = window.setInterval(() => {
      if (!fence && document.visibilityState === 'visible') {
        void startPageRecorder()
        return
      }
      if (!fence) return
      const current = fence
      void renewWriterLease(current).then((renewed) => {
        if (cancelled) return
        if (!renewed) {
          fence = null
          void stopPageRecorder(false).then(() => safeSetPhase('standby'))
        } else {
          fence = renewed
        }
      })
    }, WRITER_LEASE_RENEW_MS)
    const freshnessTimer = window.setInterval(updateDerivedPhase, 1_000)
    const replayTimer = window.setInterval(() => void flush(), 5_000)
    void startPageRecorder()

    return () => {
      cancelled = true
      flushRef.current = async () => undefined
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('online', handleResume)
      window.removeEventListener('focus', handleResume)
      window.removeEventListener('pageshow', handleResume)
      window.clearInterval(leaseTimer)
      window.clearInterval(freshnessTimer)
      window.clearInterval(replayTimer)
      stopWatch()
      const currentWake = wakeSentinel
      const currentFence = fence
      if (currentWake && !currentWake.released) void currentWake.release().catch(() => undefined)
      if (currentFence) void releaseWriterLease(currentFence)
    }
  }, [contextKey, eligible, raid.state, recoverNonce, requestServerLease, tabId])

  const recover = useCallback(() => {
    if (!raid.navigatorLease) {
      void requestServerLease('acquire')
      return
    }
    if (phase === 'standby' && message?.includes('другое устройство')) {
      void requestServerLease('recover')
      return
    }
    setRecoverNonce((value) => value + 1)
  }, [message, phase, raid.navigatorLease, requestServerLease])
  const flush = useCallback(() => flushRef.current(), [])
  return {
    phase,
    wakeLock,
    pendingCount: stats.pendingCount,
    preliminaryDistanceM: stats.preliminaryDistanceM,
    lastPersistedSampleAt: stats.lastPersistedSampleAt,
    routeStatus,
    message,
    recover,
    flush,
  }
}
