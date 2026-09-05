import { useCallback, useEffect, useRef, useState } from 'react'
import { getOneShotCoordinate } from '../checkins/platform'
import { getRaidPresence, reportRaidPresence, setManualRaidPresence } from './api'
import type { RaidPresenceRoster, RaidProjection } from './types'
import { LocationHelp } from './LocationHelp'
import { locationRecoveryMessage } from './platform'

export function RaidPresenceGate({
  identityId,
  raid,
  stale,
  onReadyChange,
}: {
  identityId: string
  raid: RaidProjection
  stale: boolean
  onReadyChange: (ready: boolean) => void
}) {
  const [roster, setRoster] = useState<RaidPresenceRoster | null>(null)
  const [status, setStatus] = useState<'locating' | 'ready' | 'blocked' | 'offline'>(() => navigator.onLine ? 'locating' : 'offline')
  const [manualBusy, setManualBusy] = useState<string | null>(null)
  const [manualError, setManualError] = useState<string | null>(null)
  const [locationError, setLocationError] = useState<string | null>(null)
  const reporting = useRef(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const viewerIsOrganizer = raid.organizerUserId === identityId

  const refreshRoster = useCallback(async () => {
    if (!navigator.onLine || document.visibilityState !== 'visible') return
    try {
      const next = await getRaidPresence(raid.id)
      setRoster(next)
    } catch {
      setRoster(null)
    }
  }, [raid.id])

  const report = useCallback(async () => {
    if (reporting.current || !navigator.onLine || stale || document.visibilityState !== 'visible') {
      if (!navigator.onLine) setStatus('offline')
      return
    }
    reporting.current = true
    setStatus('locating')
    setLocationError(null)
    try {
      const coordinate = await getOneShotCoordinate(20_000)
      if (!mounted.current) return
      if (Date.now() - Date.parse(coordinate.capturedAt) > 10_000) throw new Error('STALE_COORDINATE')
      const next = await reportRaidPresence(raid.id, coordinate)
      if (!mounted.current) return
      setRoster(next)
      setStatus('ready')
    } catch (error) {
      if (!mounted.current) return
      setStatus('blocked')
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      setLocationError(locationRecoveryMessage(code === 1 ? 'denied' : code === 3 ? 'timeout' : error instanceof Error && error.message === 'STALE_COORDINATE' ? 'stale' : 'unavailable'))
      await refreshRoster()
    } finally {
      reporting.current = false
    }
  }, [raid.id, refreshRoster, stale])

  useEffect(() => {
    void report()
    const reportTimer = window.setInterval(() => void report(), 12_000)
    const rosterTimer = window.setInterval(() => void refreshRoster(), 5_000)
    const resume = () => {
      void report()
      void refreshRoster()
    }
    window.addEventListener('online', resume)
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.clearInterval(reportTimer)
      window.clearInterval(rosterTimer)
      window.removeEventListener('online', resume)
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [refreshRoster, report])

  useEffect(() => {
    onReadyChange(Boolean(!stale && navigator.onLine && roster?.allReady))
    if (!roster) return
    const remaining = Math.max(0, Date.parse(roster.serverAt) + roster.maxAgeSeconds * 1000 - Date.now())
    const timer = window.setTimeout(() => { setRoster(null); onReadyChange(false) }, remaining)
    return () => window.clearTimeout(timer)
  }, [onReadyChange, roster, stale])

  const toggleManual = async (participantId: string, present: boolean) => {
    if (manualBusy || stale || !navigator.onLine) return
    setManualBusy(participantId)
    setManualError(null)
    try {
      setRoster(await setManualRaidPresence(raid.id, participantId, present))
    } catch {
      setManualError('Не удалось подтвердить участника. Проверьте связь и повторите.')
    } finally {
      setManualBusy(null)
    }
  }

  return <section className="kb-card raid-presence-gate" aria-label="Сбор стаи перед стартом">
    <div className="kb-section-head">
      <h2>Все на месте?</h2>
      <span className={`raid-presence-gate__summary${roster?.allReady ? ' is-ready' : ''}`}>{roster?.allReady ? 'Все готовы' : `${roster?.participants.filter(({ status: value }) => value !== 'waiting').length ?? 0}/${roster?.participants.length ?? raid.participants.filter(({ state }) => state === 'accepted' || state === 'ready').length}`}</span>
    </div>
    <p className="kb-muted">Статус обновляется автоматически, пока приложение открыто. Радиус встречи — 50 метров от организатора.</p>
    {status === 'blocked' && <p className="kb-notice" role="status">{locationError} Участника рядом организатор может отметить вручную.</p>}
    <button className="raid-location-retry" type="button" disabled={status === 'locating' || stale || !navigator.onLine} onClick={() => void report()}>{status === 'locating' ? 'Определяем местоположение…' : 'Обновить мою геолокацию'}</button>
    {status === 'blocked' && <LocationHelp />}
    {status === 'offline' && <p className="kb-notice" role="status">Нет сети. Подтверждение присутствия возобновится автоматически.</p>}
    {manualError && <p className="kb-error" role="alert">{manualError}</p>}
    {!roster && status === 'locating' && <p aria-busy="true">Определяем, кто уже приехал…</p>}
    {roster && <ul className="raid-presence-list">{roster.participants.map((participant) => <li key={participant.id} data-status={participant.status}>
      <span className="raid-avatar">{participant.displayName.slice(0, 1).toUpperCase()}</span>
      <span><strong>{participant.displayName}{participant.id === identityId ? ' · вы' : ''}</strong><small>{participant.status === 'nearby' ? 'Рядом · готов' : participant.status === 'manual' ? 'Добавлен организатором' : 'Ждём геолокацию'}</small></span>
      <i aria-label={participant.status === 'waiting' ? 'Не готов' : 'Готов'}>{participant.status === 'waiting' ? '○' : '✓'}</i>
      {viewerIsOrganizer && participant.id !== identityId && participant.status !== 'nearby' && <button disabled={manualBusy === participant.id || stale || !navigator.onLine} onClick={() => void toggleManual(participant.id, participant.status !== 'manual')} type="button">{participant.status === 'manual' ? 'Отменить' : 'Добавить вручную'}</button>}
    </li>)}</ul>}
    {!viewerIsOrganizer && <p className="raid-presence-gate__hint">Когда вся стая соберётся, организатор запустит рейд.</p>}
  </section>
}
