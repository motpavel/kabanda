import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../../lib/http'
import { getRaid } from './api'
import { readRaidProjection, saveRaidProjection } from './cache'
import type { RaidProjection } from './types'

function canUseStale(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500
}

export function useRaidProjection(identityId: string, raidId: string, staleOnly = false) {
  const [raid, setRaid] = useState<RaidProjection | null>(null)
  const [stale, setStale] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const applyRaid = useCallback(
    async (next: RaidProjection) => {
      setRaid(next)
      setStale(false)
      setSavedAt(null)
      setError(null)
      await saveRaidProjection(identityId, next)
    },
    [identityId],
  )

  const refresh = useCallback(async () => {
    if (staleOnly) {
      const cached = await readRaidProjection(identityId, raidId)
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
      await applyRaid(next)
    } catch (reason) {
      if (!canUseStale(reason)) {
        setRaid(null)
        setStale(false)
        setError('Рейд недоступен или доступ к нему отозван.')
        return
      }
      const cached = await readRaidProjection(identityId, raidId)
      if (cached) {
        setRaid(cached.raid)
        setStale(true)
        setSavedAt(cached.savedAt)
        setError(null)
      } else {
        setError('Не удалось загрузить рейд. Проверьте соединение.')
      }
    } finally {
      setLoading(false)
    }
  }, [applyRaid, identityId, raidId, staleOnly])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (staleOnly) return
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void refresh()
    }
    const timer = window.setInterval(refreshIfVisible, 5_000)
    window.addEventListener('focus', refreshIfVisible)
    window.addEventListener('online', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshIfVisible)
      window.removeEventListener('online', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [refresh, staleOnly])

  return { raid, stale, savedAt, loading, error, refresh, applyRaid }
}
