import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../lib/http'
import type { RaidProjection } from '../raids/types'
import { finishRaid } from './api'
import { drainForegroundRaidWork, getFinishLocalReview } from './local'
import {
  readResultOperationAttempt,
  resultOperationStorageKey,
  saveResultOperationAttempt,
  selectResultOperationAttempt,
  type ResultOperationAttempt,
} from './operation'
import {
  finishNeedsPartialConfirmation,
  pendingInventoryCount,
  replayableInventoryCount,
  selectFinishPrimary,
} from './state'
import type { FinishLocalReview } from './types'

export function FinishRaidPanel({
  identityId,
  raid,
  flushRoute,
  onApplyRaid,
  onCanonicalRefresh,
}: {
  identityId: string
  raid: RaidProjection
  flushRoute: () => Promise<void> | void
  onApplyRaid: (raid: RaidProjection) => Promise<unknown>
  onCanonicalRefresh: () => Promise<unknown>
}) {
  const [review, setReview] = useState<FinishLocalReview | null>(null)
  const [partialConfirmed, setPartialConfirmed] = useState(false)
  const [drainAttempted, setDrainAttempted] = useState(false)
  const [busy, setBusy] = useState<'drain' | 'finish' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const attempt = useRef<ResultOperationAttempt<{
    expectedVersion: number
    inventory: FinishLocalReview['inventory']
    confirmPartial: boolean
  }> | null>(null)
  const storageKey = resultOperationStorageKey('finish', identityId, raid.id)

  useEffect(() => {
    attempt.current = readResultOperationAttempt(storageKey)
    if (attempt.current) {
      setPartialConfirmed(attempt.current.payload.confirmPartial)
      setDrainAttempted(true)
    }
    void getFinishLocalReview(identityId, raid.id).then(setReview)
  }, [identityId, raid.id, storageKey])

  if (!raid.allowedActions.includes('finish')) return null
  const pending = review ? replayableInventoryCount(review) : 0
  const effectivePartialConfirmed = partialConfirmed && (pending === 0 || drainAttempted)
  const primary = review ? selectFinishPrimary(review, effectivePartialConfirmed, navigator.onLine) : null
  const unresolved = review ? finishNeedsPartialConfirmation(review) : false

  const drain = async () => {
    if (busy || !navigator.onLine) return
    setBusy('drain')
    setMessage(null)
    try {
      const next = await drainForegroundRaidWork({
        identityId, raidId: raid.id, flushRoute, online: true,
      })
      setReview(next)
      setDrainAttempted(true)
      if (next && pendingInventoryCount(next) > 0) {
        setMessage('Не всё получило receipt. Можно повторить отправку или явно завершить с неполным итогом.')
      }
    } catch {
      setMessage('Foreground drain не завершился. Локальные данные сохранены; повторите или подтвердите partial.')
    } finally {
      setBusy(null)
    }
  }

  const finish = async () => {
    if (!review || busy || !navigator.onLine || (unresolved && !effectivePartialConfirmed)) return
    setBusy('finish')
    setMessage(null)
    const payload = { expectedVersion: raid.version, inventory: review.inventory, confirmPartial: effectivePartialConfirmed }
    const fingerprint = JSON.stringify([raid.id, payload])
    const selected = selectResultOperationAttempt(attempt.current, fingerprint, payload)
    attempt.current = selected
    saveResultOperationAttempt(storageKey, selected)
    try {
      const response = await finishRaid(
        raid.id,
        selected.payload.expectedVersion,
        selected.payload.inventory,
        selected.payload.confirmPartial,
        selected.key,
      )
      // Keep the exact payload/key through remounts until ResultPanel observes
      // the canonical completed result. A finish receipt may still be a stale
      // finalizing projection after a lost response.
      await onApplyRaid(response.raid)
      await onCanonicalRefresh()
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'Завершение не подтверждено. Повтор использует тот же idempotency key.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="kb-card result-finish-review">
      <div className="kb-section-head"><div><p className="kb-kicker">Перед финишем</p><h2>Что ещё ждёт receipt</h2></div></div>
      {!review ? <p className="kb-muted" aria-busy="true">Проверяем локальную очередь…</p> : (
        <>
          <dl className="result-inventory">
            <div><dt>Маршрут</dt><dd>{review.inventory.routePending}</dd></div>
            <div><dt>Чекины</dt><dd>{review.inventory.checkInsPending}</dd></div>
            <div><dt>Фото</dt><dd>{review.inventory.mediaPending}</dd></div>
            <div><dt>Нужно действие</dt><dd>{review.inventory.needsAction}</dd></div>
          </dl>
          {unresolved && (pending === 0 || drainAttempted) && (
            <label className="result-partial-confirm">
              <input type="checkbox" checked={partialConfirmed} onChange={(event) => setPartialConfirmed(event.target.checked)} />
              <span><strong>Подтверждаю неполный итог</strong><small>Непринятые сервером данные не попадут в канонические метрики.</small></span>
            </label>
          )}
        </>
      )}
      {message && <p className="kb-notice" role="status">{message}</p>}
      {primary === 'drain' && <button className="kb-link-button" type="button" disabled={Boolean(busy)} onClick={drain}>{busy === 'drain' ? 'Досылаем…' : 'Дослать сохранённое'}</button>}
      {primary === 'finish' && <button className="kb-link-button" type="button" disabled={Boolean(busy)} onClick={finish}>{busy === 'finish' ? 'Завершаем…' : unresolved ? 'Завершить с неполным итогом' : 'Завершить рейд'}</button>}
    </section>
  )
}
