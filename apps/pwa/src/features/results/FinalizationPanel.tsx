import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../../lib/http'
import { CheckInPanel } from '../checkins/CheckInPanel'
import type { RaidProjection } from '../raids/types'
import { settleFinalization } from './api'
import { saveRaidResult } from './cache'
import { drainFinalizingServerTail } from './local'
import {
  readResultOperationAttempt,
  resultOperationStorageKey,
  saveResultOperationAttempt,
  selectResultOperationAttempt,
  type ResultOperationAttempt,
} from './operation'

export function FinalizationPanel({
  identityId,
  raid,
  staleProjection,
  onCanonicalRefresh,
  onApplyRaid,
}: {
  identityId: string
  raid: RaidProjection
  staleProjection: boolean
  onCanonicalRefresh: () => Promise<unknown>
  onApplyRaid: (raid: RaidProjection) => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const attempt = useRef<ResultOperationAttempt<{ expectedVersion: number }> | null>(null)
  const drainInFlight = useRef(false)
  const drainTimer = useRef<number | null>(null)
  const drainRef = useRef<() => void>(() => undefined)
  const drainGeneration = useRef(0)
  const storageKey = resultOperationStorageKey('settle', identityId, raid.id)
  const finalization = raid.finalization
  const deadlineAt = finalization?.deadlineAt ?? null

  const drain = useCallback(async () => {
    if (
      drainInFlight.current ||
      staleProjection ||
      !navigator.onLine ||
      document.visibilityState !== 'visible'
    ) return
    const generation = drainGeneration.current
    drainInFlight.current = true
    try {
      const result = await drainFinalizingServerTail({ identityId, raidId: raid.id, online: true })
      await onCanonicalRefresh()
      const beforeDeadline = deadlineAt && Date.parse(deadlineAt) > Date.now()
      if (result.mayHaveMore && beforeDeadline && drainGeneration.current === generation) {
        if (drainTimer.current !== null) window.clearTimeout(drainTimer.current)
        drainTimer.current = window.setTimeout(() => drainRef.current(), 500)
      }
    } finally {
      drainInFlight.current = false
    }
  }, [deadlineAt, identityId, onCanonicalRefresh, raid.id, staleProjection])

  useEffect(() => {
    drainGeneration.current += 1
    attempt.current = readResultOperationAttempt(storageKey)
    drainRef.current = () => void drain().catch(() => undefined)
    drainRef.current()
    const resume = () => drainRef.current()
    window.addEventListener('online', resume)
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      drainGeneration.current += 1
      window.removeEventListener('online', resume)
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
      if (drainTimer.current !== null) window.clearTimeout(drainTimer.current)
    }
  }, [drain, storageKey])

  const settle = async () => {
    if (busy || staleProjection || !navigator.onLine || !raid.allowedActions.includes('settle-finalization')) return
    setBusy(true)
    setMessage(null)
    const payload = { expectedVersion: raid.version }
    const selected = selectResultOperationAttempt(attempt.current, JSON.stringify([raid.id, payload]), payload)
    attempt.current = selected
    saveResultOperationAttempt(storageKey, selected)
    try {
      const response = await settleFinalization(raid.id, selected.payload.expectedVersion, selected.key)
      await saveRaidResult(identityId, response.result)
      await onApplyRaid(response.raid)
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'Итог ещё не подтверждён. Повтор использует тот же ключ.')
      await onCanonicalRefresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="kb-card result-finalizing">
        <p className="kb-kicker">Каноническая финализация</p>
        <h2>Сервер собирает итог</h2>
        <p className="kb-muted">Новый маршрут, check-in и media intent уже не создаются. Принимаются только известные серверу хвосты.</p>
        {finalization ? (
          <>
            <dl className="result-inventory">
              <div><dt>Claims</dt><dd>{finalization.pendingCounts.claims}</dd></div>
              <div><dt>Fallbacks</dt><dd>{finalization.pendingCounts.fallbacks}</dd></div>
              <div><dt>Media</dt><dd>{finalization.pendingCounts.media}</dd></div>
            </dl>
            <p className="kb-muted">Deadline: {new Date(finalization.deadlineAt).toLocaleString('ru-RU')}{finalization.partial ? ' · итог будет partial' : ''}</p>
          </>
        ) : <p className="kb-muted">Обновляем finalization projection…</p>}
        {message && <p className="kb-notice" role="status">{message}</p>}
        {raid.allowedActions.includes('settle-finalization') && !staleProjection && (
          <button className="kb-primary raid-primary" type="button" disabled={busy || !navigator.onLine} onClick={settle}>{busy ? 'Фиксируем…' : 'Зафиксировать итог'}</button>
        )}
        {!raid.allowedActions.includes('settle-finalization') && <button className="kb-link-button" type="button" disabled={staleProjection || !navigator.onLine} onClick={() => drainRef.current()}>Проверить статус</button>}
      </section>
      <CheckInPanel
        identityId={identityId}
        raid={raid}
        staleProjection={staleProjection}
        onCanonicalRefresh={onCanonicalRefresh}
        serverTailOnly
      />
    </>
  )
}
