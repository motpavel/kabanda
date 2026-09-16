import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../../lib/http'
import { useVisibleRead } from './read-refresh'
import { getRaid } from './api'
import { readRaidProjection, saveRaidProjection } from './cache'
import type { RaidProjection } from './types'

function canUseStale(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500
}

export function useRaidProjection(identityId: string, raidId: string, staleOnly = false) {
  const scope = useMemo(() => ({ active: true, canonicalSettled: false }), [identityId, raidId, staleOnly])
  const [raid, setRaid] = useState<RaidProjection | null>(null)
  const latestApplied = useRef<{ identityId: string; raid: RaidProjection } | null>(null)
  const [stale, setStale] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const applyRaid = useCallback(
    async (next: RaidProjection) => {
      if (!scope.active) return
      scope.canonicalSettled = true
      const current = latestApplied.current
      if (current?.identityId === identityId && current.raid.id === next.id && current.raid.version > next.version) return
      latestApplied.current = { identityId, raid: next }
      setRaid(next)
      setStale(false)
      setSavedAt(null)
      setError(null)
      await saveRaidProjection(identityId, next).catch(() => undefined)
    },
    [identityId, scope],
  )

  const load = useCallback(async () => {
    const appliedAtStart = latestApplied.current
    if (staleOnly) {
      const cached = await readRaidProjection(identityId, raidId)
      if (!scope.active) return
      if (cached) {
        setRaid(cached.raid)
        setStale(true)
        setSavedAt(cached.savedAt)
        setError(null)
      } else {
        setRaid(null)
        setStale(false)
        setError('Для этого пользователя нет сохранённой копии рейда.')
      }
      setLoading(false)
      return
    }
    try {
      const next = await getRaid(raidId)
      scope.canonicalSettled = true
      // Readiness can change without a lifecycle version bump. A response that
      // began before any confirmed apply must not overwrite that newer result.
      if (!scope.active || latestApplied.current !== appliedAtStart) return
      await applyRaid(next)
    } catch (reason) {
      scope.canonicalSettled = true
      if (!scope.active || latestApplied.current !== appliedAtStart) return
      if (!canUseStale(reason)) {
        setRaid(null)
        setStale(false)
        setError('Рейд недоступен или доступ к нему отозван.')
        return
      }
      const cached = await readRaidProjection(identityId, raidId).catch(() => null)
      if (!scope.active || latestApplied.current !== appliedAtStart) return
      if (cached) {
        setRaid(cached.raid)
        setStale(true)
        setSavedAt(cached.savedAt)
        setError(null)
      } else {
        setError('Не удалось загрузить рейд. Проверьте соединение.')
      }
    } finally {
      if (scope.active) setLoading(false)
    }
  }, [applyRaid, identityId, raidId, staleOnly, scope])

  useEffect(() => {
    scope.active = true
    void readRaidProjection(identityId, raidId).then(cached => {
      if (!scope.active || scope.canonicalSettled) return
      if (cached) {
        setRaid(cached.raid)
        setStale(true)
        setSavedAt(cached.savedAt)
        setError(null)
        setLoading(false)
      } else if (staleOnly || !navigator.onLine) {
        setRaid(null)
        setError('Для этого пользователя нет сохранённой копии рейда.')
        setLoading(false)
      }
    }).catch(() => {
      if (scope.active && (staleOnly || !navigator.onLine)) {
        setError('Не удалось прочитать сохранённую копию рейда.')
        setLoading(false)
      }
    })
    return () => { scope.active = false }
  }, [identityId, raidId, scope, staleOnly])

  const refresh = useVisibleRead(load, `${identityId}:${raidId}:${staleOnly}`, !staleOnly, 5_000)

  return { raid, stale, savedAt, loading, error, refresh, applyRaid }
}
