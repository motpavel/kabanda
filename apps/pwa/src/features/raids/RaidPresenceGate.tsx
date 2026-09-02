import { useCallback, useEffect, useState } from 'react'
import { getOneShotCoordinate } from '../checkins/platform'
import { getRaidPresence, reportRaidPresence, setManualRaidPresence } from './api'
import type { RaidPresenceRoster, RaidProjection } from './types'

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
  const viewerIsOrganizer = raid.organizerUserId === identityId

  const refreshRoster = useCallback(async () => {
    if (!navigator.onLine || document.visibilityState !== 'visible') return
    try {
      const next = await getRaidPresence(raid.id)
      setRoster(next)
    } catch {
      // The fresh location submission below remains the primary recovery path.
    }
  }, [raid.id])

  const report = useCallback(async () => {
    if (!navigator.onLine || stale || document.visibilityState !== 'visible') {
      if (!navigator.onLine) setStatus('offline')
      return
    }
    try {
      const coordinate = await getOneShotCoordinate(10_000)
      const next = await reportRaidPresence(raid.id, coordinate)
      setRoster(next)
      setStatus('ready')
    } catch {
      setStatus('blocked')
      await refreshRoster()
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
    onReadyChange(Boolean(roster?.allReady))
  }, [onReadyChange, roster?.allReady])

  const toggleManual = async (participantId: string, present: boolean) => {
    if (manualBusy || stale || !navigator.onLine) return
    setManualBusy(participantId)
    try {
      setRoster(await setManualRaidPresence(raid.id, participantId, present))
    } finally {
      setManualBusy(null)
    }
  }

  return <section className="kb-card raid-presence-gate" aria-label="Сбор стаи перед стартом">
    <div className="kb-section-head">
      <div><p className="kb-kicker">Перед стартом</p><h2>Все на месте?</h2></div>
      <span className={`raid-presence-gate__summary${roster?.allReady ? ' is-ready' : ''}`}>{roster?.allReady ? 'Все готовы' : `${roster?.participants.filter(({ status: value }) => value !== 'waiting').length ?? 0}/${roster?.participants.length ?? raid.participants.filter(({ state }) => state === 'accepted' || state === 'ready').length}`}</span>
    </div>
    <p className="kb-muted">Статус обновляется автоматически, пока приложение открыто. Радиус встречи — 50 метров от организатора.</p>
    {status === 'blocked' && <p className="kb-notice" role="status">Не получили свежую геолокацию. Разрешите доступ или попросите организатора отметить вас вручную.</p>}
    {status === 'offline' && <p className="kb-notice" role="status">Нет сети. Подтверждение присутствия возобновится автоматически.</p>}
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
