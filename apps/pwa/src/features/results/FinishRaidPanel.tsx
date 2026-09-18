import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../lib/http'
import type { RaidProjection } from '../raids/types'
import { finishRaid } from './api'
import { completeReadyRaid } from './complete'
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
} from './state'
import type { FinishLocalReview } from './types'

export function FinishRaidPanel({
  identityId,
  raid,
  flushRoute,
  onApplyRaid,
  onCanonicalRefresh,
  presentation = 'card',
}: {
  identityId: string
  raid: RaidProjection
  flushRoute: () => Promise<void> | void
  onApplyRaid: (raid: RaidProjection) => Promise<unknown>
  onCanonicalRefresh: () => Promise<unknown>
  presentation?: 'card' | 'sheet'
}) {
  const [review, setReview] = useState<FinishLocalReview | null>(null)
  const [partialConfirmed, setPartialConfirmed] = useState(false)
  const [busy, setBusy] = useState<'finish' | null>(null)
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
    }
    void getFinishLocalReview(identityId, raid.id).then(setReview).catch(() => setMessage('Не удалось проверить сохранённые данные. Закройте окно и попробуйте ещё раз.'))
  }, [identityId, raid.id, storageKey])

  if (!raid.allowedActions.includes('finish')) return null
  const effectivePartialConfirmed = partialConfirmed
  const unresolved = review ? finishNeedsPartialConfirmation(review) : false

  const finish = async () => {
    if (!review || busy || !navigator.onLine) return
    setBusy('finish')
    setMessage(null)
    try {
      const fresh = await drainForegroundRaidWork({ identityId, raidId: raid.id, flushRoute, online: true })
        .catch((error: unknown) => {
          if (!effectivePartialConfirmed) throw error
          return getFinishLocalReview(identityId, raid.id)
        })
      if (!fresh) throw new Error('Identity unavailable')
      setReview(fresh)
      if (pendingInventoryCount(fresh) > 0 && !effectivePartialConfirmed) {
        setMessage('Не всё удалось отправить. Попробуйте ещё раз или подтвердите завершение без этих данных.')
        setBusy(null)
        return
      }
      const payload = { expectedVersion: raid.version, inventory: fresh.inventory, confirmPartial: effectivePartialConfirmed }
      const fingerprint = JSON.stringify([raid.id, payload])
      const selected = selectResultOperationAttempt(attempt.current, fingerprint, payload)
      attempt.current = selected
      saveResultOperationAttempt(storageKey, selected)
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
      // Finish normally reaches the result while this confirmation is still open.
      // If uploads remain or the response is lost, the result page resumes saving.
      let next = response.raid
      try { next = await completeReadyRaid(identityId, next) } catch { /* Recover on the result page. */ }
      await onApplyRaid(next)
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'Завершение не подтверждено. Нажмите ещё раз — повтор не создаст второй итог.')
      await onCanonicalRefresh().catch(() => undefined)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className={presentation === 'sheet' ? 'result-finish-review result-finish-review--sheet' : 'kb-card result-finish-review'}>
      {presentation === 'card' && <div className="kb-section-head"><div><p className="kb-kicker">Перед финишем</p><h2>Сохранение рейда</h2></div></div>}
      {presentation === 'sheet' && <p>Запись остановится для всей Кабанды. Рейд появится в истории участников.</p>}
      {!review ? <p className="kb-muted" aria-busy="true">Проверяем сохранение…</p> : (
        <>
          {presentation === 'sheet' && !unresolved && <p className="result-finish-review__saved">Все данные отправлены</p>}
          {(presentation === 'card' || unresolved) && <dl className="result-inventory">
            <div><dt>Маршрут</dt><dd>{review.inventory.routePending}</dd></div>
            <div><dt>Посещения</dt><dd>{review.inventory.checkInsPending}</dd></div>
            <div><dt>Фото</dt><dd>{review.inventory.mediaPending}</dd></div>
            <div><dt>Нужно действие</dt><dd>{review.inventory.needsAction}</dd></div>
          </dl>}
          {unresolved && (
            <label className="result-partial-confirm">
              <input type="checkbox" disabled={Boolean(busy)} checked={partialConfirmed} onChange={(event) => setPartialConfirmed(event.target.checked)} />
              <span><strong>Завершить без неотправленных данных</strong><small>Они останутся на телефоне, но не войдут в итог рейда.</small></span>
            </label>
          )}
        </>
      )}
      {message && <p className="kb-notice" role="status">{message}</p>}
      {!navigator.onLine && <p className="kb-notice" role="status">Для завершения нужен интернет. Сохранённые данные останутся на телефоне.</p>}
      <button className="kb-primary" type="button" disabled={!review || Boolean(busy) || !navigator.onLine} onClick={finish}>{busy ? 'Сохраняем рейд…' : partialConfirmed && unresolved ? 'Завершить без неотправленных данных' : 'Да, завершить рейд'}</button>
    </section>
  )
}
