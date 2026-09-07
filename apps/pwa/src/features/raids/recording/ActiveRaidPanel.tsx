import { useCallback, useEffect, useRef, useState } from 'react'
import type { RaidPrimaryAction } from '../state'
import type { RaidMapPoint, RaidProjection } from '../types'
import { PointVisitHistory } from '../../checkins/PointVisitHistory'
import { selectActivePrimaryAction } from './state'
import { useRouteRecorder } from './useRouteRecorder'
import { CheckInPanel } from '../../checkins/CheckInPanel'
import { FinishRaidPanel } from '../../results/FinishRaidPanel'
import { RaidRouteMap } from './RaidRouteMap'
import { useRaidProximity } from './useRaidProximity'
import { RaidControlIcon } from '../RaidControlIcon'
import { useSlideSheet } from './useSlideSheet'
import { distanceMeters } from './store'
import { setRaidDestination } from '../api'
import { ApiError } from '../../../lib/http'
import { destinationKey, selectArrivalPoint } from './destination'

export function ActiveRaidPanel({
  identityId,
  raid,
  staleProjection,
  serverPrimary,
  operationPending,
  onServerPrimary,
  onCanonicalRefresh,
  onApplyRaid,
  backHref,
  pageMessage,
  resourceError,
}: {
  identityId: string
  raid: RaidProjection
  staleProjection: boolean
  serverPrimary: RaidPrimaryAction | null
  operationPending: boolean
  onServerPrimary: () => void
  onCanonicalRefresh: () => Promise<unknown>
  onApplyRaid: (raid: RaidProjection) => Promise<unknown>
  backHref: string
  pageMessage: string | null
  resourceError: string | null
}) {
  const recorder = useRouteRecorder({ identityId, raid, staleProjection, onCanonicalRefresh, onApplyRaid })
  const proximity = useRaidProximity(identityId, raid.id, raid.state === 'active')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [checkInNotice, setCheckInNotice] = useState<{ text: string } | null>(null)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [finishOpen, setFinishOpen] = useState(false)
  const actionsTrigger = useRef<HTMLButtonElement>(null)
  const previousRaidState = useRef(raid.state)
  const [historyPoint, setHistoryPoint] = useState<RaidMapPoint | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const inspectedPoint = historyOpen ? historyPoint : null
  const [repeatPointId, setRepeatPointId] = useState<string | null>(null)
  const [selectedArrivalId, setSelectedArrivalId] = useState<string | null>(null)
  const [handledDestination, setHandledDestination] = useState('')
  const [destinationBusy, setDestinationBusy] = useState(false)
  const [destinationError, setDestinationError] = useState<string | null>(null)
  const destinationAttempt = useRef<{ pointSnapshotId: string; expectedVersion: number; operationId: string } | null>(null)
  const destination = raid.destination ?? null
  const currentDestinationKey = destinationKey(destination)
  useEffect(() => { setSelectedArrivalId(null); setRepeatPointId(null) }, [currentDestinationKey])
  useEffect(() => { setDestinationError(null) }, [historyPoint?.id])
  const inspectPoint = useCallback((point: RaidMapPoint) => { setHistoryPoint(point); setHistoryOpen(true); setSheetOpen(false) }, [])
  const [pendingCheckIns, setPendingCheckIns] = useState(0)
  const [checkInAttention, setCheckInAttention] = useState({ count: 0, key: '', actionKey: '' })
  const lastPresentedPoint = useRef<string | null>(null)
  const lastPresentedAttention = useRef('')
  const onCheckInRefused = useCallback((text: string) => {
    setCheckInNotice({ text })
    setSheetOpen(false)
    setRepeatPointId(null)
    void proximity.refresh()
  }, [proximity.refresh])
  useEffect(() => {
    if (!checkInNotice) return
    const timer = window.setTimeout(() => setCheckInNotice(null), 10_000)
    return () => window.clearTimeout(timer)
  }, [checkInNotice])
  const activePoint = raid.state === 'active' ? selectArrivalPoint({
    nearby: proximity.nearby, planned: Boolean(raid.routeTemplateId), destination, handledDestination,
    selectedPointId: selectedArrivalId, repeatPointId,
  }) : null
  const inspectedNearby = proximity.nearby.find((point) => point.pointSnapshotId === historyPoint?.id)
  const inspectedDistance = inspectedNearby?.distanceMeters ?? (historyPoint && proximity.coordinate
    ? distanceMeters(proximity.coordinate, historyPoint) : null)
  const inspectedDistanceLabel = inspectedDistance === null ? null : inspectedDistance >= 1_000
    ? { value: (inspectedDistance / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }), unit: 'км' }
    : { value: Math.round(inspectedDistance), unit: 'метров' }
  // A delayed proximity response cannot undo an already confirmed map credit.
  const inspectedVisited = Boolean(inspectedNearby?.creditedByMe || historyPoint?.visitedByMe)
  const viewerIsOrganizer = raid.organizerUserId === identityId
  const serverActionAvailable = serverPrimary?.kind === 'command' || serverPrimary?.kind === 'refresh'
  const primary = selectActivePrimaryAction(recorder.phase, serverActionAvailable)
  const viewerIsNavigator = raid.navigatorUserId === identityId
  // Only changing the recording device or recovering local storage needs intent.
  // GPS outages recover automatically; denied permission is explained in the notice.
  const showRecovery = viewerIsNavigator && raid.state === 'active' && primary === 'recover' &&
    (recorder.phase === 'standby' || recorder.phase === 'error')
  const recoveryLabel = recorder.phase === 'standby' ? 'Записывать на этом устройстве' : 'Повторить сохранение'
  const hasCheckInAttention = checkInAttention.count > 0
  const arrivalAvailable = raid.state === 'active' && Boolean(activePoint || hasCheckInAttention)
  const actionsSheet = useSlideSheet<HTMLDialogElement>(actionsOpen, () => setActionsOpen(false))
  const arrivalSheet = useSlideSheet<HTMLElement>(sheetOpen && arrivalAvailable && !inspectedPoint && !actionsOpen, () => setSheetOpen(false))
  const historySheet = useSlideSheet<HTMLElement>(historyOpen && !actionsOpen, () => setHistoryOpen(false))
  useEffect(() => { historySheet.ref.current?.scrollTo({ top: 0 }) }, [historyPoint?.id, historySheet.ref])
  const recorderLabel = viewerIsNavigator ? ({
    fresh: 'Маршрут записывается',
    waiting: 'Ищем GPS-сигнал',
    recovering: 'Запускаем запись маршрута',
    stale: 'GPS давно не обновлялся',
    standby: 'Запись на другом устройстве',
    blocked: 'Нет доступа к геолокации',
    error: 'Запись маршрута остановлена',
    paused: 'Запись на паузе',
    ineligible: 'Запись недоступна',
  } as const)[recorder.phase] : null

  useEffect(() => {
    if (previousRaidState.current !== raid.state) {
      setActionsOpen(false)
      setFinishOpen(false)
      previousRaidState.current = raid.state
    }
  }, [raid.state])

  useEffect(() => {
    if (!activePoint) {
      lastPresentedPoint.current = null
      return
    }
    const presentationKey = `${activePoint.pointSnapshotId}:${activePoint.pointSnapshotId === destination?.pointSnapshotId ? currentDestinationKey : ''}`
    if (presentationKey === lastPresentedPoint.current) return
    lastPresentedPoint.current = presentationKey
    if (activePoint.pointSnapshotId === destination?.pointSnapshotId) setHistoryOpen(false)
    setSheetOpen(true)
  }, [activePoint, currentDestinationKey, destination?.pointSnapshotId])

  useEffect(() => {
    if (!checkInAttention.actionKey) {
      lastPresentedAttention.current = ''
      return
    }
    if (checkInAttention.actionKey === lastPresentedAttention.current) return
    lastPresentedAttention.current = checkInAttention.actionKey
    setSheetOpen(true)
  }, [checkInAttention])

  const chooseDestination = async () => {
    if (!historyPoint || destinationBusy || staleProjection || !navigator.onLine || !viewerIsNavigator) return
    if (destinationAttempt.current?.pointSnapshotId !== historyPoint.id) {
      destinationAttempt.current = { pointSnapshotId: historyPoint.id, expectedVersion: raid.version, operationId: crypto.randomUUID() }
    }
    const attempt = destinationAttempt.current!
    setDestinationBusy(true)
    setDestinationError(null)
    try {
      const next = await setRaidDestination(raid.id, { expectedVersion: attempt.expectedVersion, pointSnapshotId: attempt.pointSnapshotId }, attempt.operationId)
      destinationAttempt.current = null
      await onApplyRaid(next)
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        destinationAttempt.current = null
        void onCanonicalRefresh()
      }
      setDestinationError(error instanceof ApiError && error.code === 'RAID_VERSION_CONFLICT'
        ? 'Цель рейда изменилась. Повторите выбор.' : 'Не удалось подтвердить цель. Попробуйте ещё раз.')
    } finally { setDestinationBusy(false) }
  }
  const refreshAfterCheckIn = useCallback(async () => {
    await onCanonicalRefresh()
    await proximity.refresh()
  }, [onCanonicalRefresh, proximity.refresh])
  const destinationIsArrival = Boolean(activePoint && activePoint.pointSnapshotId === destination?.pointSnapshotId)
  const repeatArrival = Boolean(!raid.routeTemplateId && activePoint?.creditedByMe &&
    (destinationIsArrival || repeatPointId === activePoint.pointSnapshotId))
  const onCheckInSaved = () => {
    if (destinationIsArrival) setHandledDestination(currentDestinationKey)
    setSelectedArrivalId(null)
    setRepeatPointId(null)
    setSheetOpen(false)
  }

  const proximityLabel = proximity.status === 'offline'
    ? 'Нет сети · маршрут сохраняется'
    : proximity.status === 'blocked'
      ? 'Разрешите геолокацию для поиска точек'
      : proximity.status === 'locating'
        ? 'Определяем ближайшую точку…'
        : 'Едем дальше · ищем точку в радиусе 50 м'

  return <section className="raid-active-map" aria-label={`Активный рейд ${raid.title}`}>
    <RaidRouteMap
      identityId={identityId}
      planned={Boolean(raid.routeTemplateId)}
      destinationPointId={destination?.pointSnapshotId ?? null}
      highlightedPointId={activePoint?.pointSnapshotId ?? null}
      live={raid.state === 'active'}
      location={proximity.coordinate}
      raidId={raid.id}
      onSelectPoint={inspectPoint}
    />

    <header className="raid-active-map__header">
      <a aria-label="Выйти из карты рейда" href={backHref}><RaidControlIcon name="back" /></a>
      <div><small>{raid.state === 'paused' ? 'Рейд на паузе' : recorderLabel ?? 'Активный рейд'}</small><strong>{raid.title}</strong></div>
      <button ref={actionsTrigger} aria-haspopup="dialog" aria-expanded={actionsOpen} aria-label="Действия рейда" onClick={() => { setFinishOpen(false); setActionsOpen(true) }} type="button"><RaidControlIcon name="more" /></button>
    </header>

    <dialog {...actionsSheet} className="raid-active-map__actions" aria-labelledby="raid-actions-title" onClose={() => actionsTrigger.current?.focus({ preventScroll: true })} onCancel={(event) => { event.preventDefault(); setActionsOpen(false) }} onClick={(event) => { if (event.target === event.currentTarget) setActionsOpen(false) }}>
      <div className="raid-action-sheet">
        <button className="raid-sheet-grip" data-sheet-drag="true" aria-label="Свернуть действия рейда" onClick={() => setActionsOpen(false)} type="button"><span /></button>
        <header className="raid-action-sheet__header" data-sheet-drag="true">
          <h2 id="raid-actions-title">{finishOpen ? 'Завершить рейд?' : 'Ваш рейд'}</h2>
        </header>
        {finishOpen ? <>
          <FinishRaidPanel presentation="sheet" identityId={identityId} raid={raid} flushRoute={recorder.flush} onApplyRaid={onApplyRaid} onCanonicalRefresh={onCanonicalRefresh} />
          <button className="raid-action-sheet__cancel" type="button" onClick={() => setFinishOpen(false)}>Вернуться к действиям</button>
        </> : <div className="raid-action-sheet__list">
          {serverActionAvailable && serverPrimary && <button className="raid-action-sheet__item" type="button" disabled={operationPending} onClick={onServerPrimary}><RaidControlIcon name={raid.state === 'paused' ? 'play' : 'pause'} /><span>{operationPending ? 'Подтверждаем…' : serverPrimary.label}</span></button>}
          {raid.allowedActions.includes('finish') && <button className="raid-action-sheet__item raid-action-sheet__item--finish" type="button" onClick={() => setFinishOpen(true)}><RaidControlIcon name="finish" /><span>Завершить рейд</span></button>}
          {!serverActionAvailable && !raid.allowedActions.includes('finish') && <p className="raid-action-sheet__hint">Пауза и завершение доступны вожаку рейда.</p>}
        </div>}
      </div>
    </dialog>

    {!actionsOpen && (checkInNotice || pageMessage || resourceError || (raid.state === 'active' && recorder.message) || showRecovery) && <section className="raid-active-map__notice" aria-label="Состояние активного рейда" data-phase={recorder.phase}>
      {checkInNotice && <p className="raid-checkin-refusal" role="status">{checkInNotice.text}</p>}
      {resourceError && <p className="kb-error" role="alert">{resourceError}</p>}
      {pageMessage && <p className="kb-notice" role="status">{pageMessage}</p>}
      {raid.state === 'active' && recorder.message && <p className={recorder.phase === 'waiting' ? 'raid-gps-waiting' : 'kb-error'} role={recorder.phase === 'waiting' ? 'status' : 'alert'}>{recorder.message}</p>}
      {showRecovery && <button className="kb-primary route-recorder__secondary" type="button" onClick={recorder.recover}>{recoveryLabel}</button>}
    </section>}

    {arrivalAvailable && !sheetOpen && !inspectedPoint && !actionsOpen && <button className="raid-arrival-pill" onClick={() => setSheetOpen(true)} type="button">
      <span aria-hidden="true" />
      <span><strong>{activePoint ? 'Вы рядом с точкой' : pendingCheckIns > 0 ? 'Сохранено без сети' : 'Сохранённые отметки'}</strong><small>{activePoint ? `${activePoint.name} · ${Math.round(activePoint.distanceMeters)} м` : pendingCheckIns > 0 ? `${pendingCheckIns} действий ждут синхронизации` : 'Подтверждения и проверка по фото'}</small></span>
      <b>{activePoint ? 'Пометить' : 'Открыть'}</b>
    </button>}

    <aside {...arrivalSheet} className="raid-arrival-sheet raid-arrival-sheet--checkin" aria-label={activePoint ? 'Подтверждение точки' : 'Сохранённые действия'}>
      <button className="raid-arrival-sheet__collapse" data-sheet-drag="true" aria-label="Свернуть подтверждение точки" onClick={() => setSheetOpen(false)} type="button"><span /></button>
      <div className="raid-arrival-sheet__heading" data-sheet-drag="true">
        <div><small>{activePoint ? destinationIsArrival ? 'ВЫ НА МЕСТЕ' : 'ТОЧКА РЯДОМ' : 'ОТМЕТКИ'}</small><h2>{activePoint?.name ?? 'Сохранённые отметки'}</h2></div>
        {activePoint && <span className="raid-arrival-sheet__distance">{Math.round(activePoint.distanceMeters)}<small>метров</small></span>}
      </div>
      {!viewerIsOrganizer && activePoint && <p className="raid-arrival-sheet__waiting">Вы на месте. Подтвердите своё посещение.</p>}
      <CheckInPanel identityId={identityId} nearbyPoints={activePoint ? [activePoint] : []} onRefused={onCheckInRefused} onAttentionChange={setCheckInAttention} onCanonicalRefresh={refreshAfterCheckIn} onPendingChange={setPendingCheckIns} presentation="map-sheet" raid={raid} staleProjection={staleProjection} repeatVisit={repeatArrival} onSaved={onCheckInSaved} />
    </aside>

    <aside {...historySheet} className="raid-arrival-sheet raid-point-history-sheet" aria-label={historyPoint ? `История точки: ${historyPoint.name}` : 'История точки'} onKeyDown={(event) => { if (event.key === 'Escape') setHistoryOpen(false) }}>
      <button className="raid-arrival-sheet__collapse" data-sheet-drag="true" aria-label="Свернуть историю точки" onClick={() => setHistoryOpen(false)} type="button"><span /></button>
      {historyPoint && <>
        <div className="raid-arrival-sheet__heading" data-sheet-drag="true">
          <div><small>{historyPoint.id === destination?.pointSnapshotId ? 'ДВИГАЕМСЯ СЮДА' : 'ТОЧКА РЕЙДА'}</small><h2>{historyPoint.name}</h2></div>
          {inspectedDistanceLabel && <span className="raid-arrival-sheet__distance">{inspectedDistanceLabel.value}<small>{inspectedDistanceLabel.unit}</small></span>}
        </div>
        <PointVisitHistory key={`${identityId}:${historyPoint.sourcePointId}`} identityId={identityId} kabandaId={raid.kabandaId} pointId={historyPoint.sourcePointId} currentRaidId={raid.id} onOpenRaid={() => setHistoryOpen(false)} active={historyOpen && !actionsOpen} />
        {raid.state === 'active' && inspectedNearby && !(raid.routeTemplateId && inspectedVisited) && <div className="raid-point-history-sheet__action">
          <button type="button" className="kb-primary raid-primary" disabled={pendingCheckIns > 0} onClick={() => {
            setRepeatPointId(inspectedVisited ? historyPoint.id : null)
            setSelectedArrivalId(historyPoint.id)
            setHistoryOpen(false)
            setSheetOpen(true)
          }}>Пометить точку</button>
        </div>}
        {raid.state === 'active' && !inspectedNearby && viewerIsNavigator && !(raid.routeTemplateId && inspectedVisited) && <div className="raid-point-history-sheet__action">
          {destinationError && <p className="kb-error" role="alert">{destinationError}</p>}
          <button type="button" className="raid-destination-action" disabled={destinationBusy || staleProjection || !navigator.onLine || historyPoint.id === destination?.pointSnapshotId} onClick={() => void chooseDestination()}>
            <RaidControlIcon name="pin" />{destinationBusy ? 'Выбираем цель…' : historyPoint.id === destination?.pointSnapshotId ? 'Двигаемся сюда' : 'Двигаться сюда'}
          </button>
        </div>}
      </>}
    </aside>

    {destination && raid.state === 'active' && !arrivalAvailable && !inspectedPoint && !actionsOpen && <button className="raid-arrival-pill raid-destination-pill" type="button" onClick={() => inspectPoint({ id: destination.pointSnapshotId, sourcePointId: destination.sourcePointId, name: destination.name, latitude: destination.latitude, longitude: destination.longitude, position: 0, visitedByMe: false, visitedByTeam: false })}>
      <RaidControlIcon name="pin" /><span><strong>Двигаемся сюда</strong><small>{destination.name}</small></span><b aria-hidden="true">›</b>
    </button>}

    {raid.state === 'paused' && !actionsOpen && !inspectedPoint ? <section className="raid-paused-banner" aria-label="Рейд на паузе">
      <span className="raid-paused-banner__icon"><RaidControlIcon name="pause" /></span>
      <div><strong>Рейд на паузе</strong><p>{viewerIsOrganizer ? 'Запись и чекины приостановлены.' : 'Ждём, когда вожак продолжит рейд.'}</p></div>
      {serverPrimary?.kind === 'command' && serverPrimary.command === 'resume' && <button className="kb-primary" type="button" disabled={operationPending} onClick={onServerPrimary}><RaidControlIcon name="play" />{operationPending ? 'Продолжаем…' : 'Продолжить рейд'}</button>}
    </section> : raid.state === 'active' && !destination && !arrivalAvailable && !inspectedPoint && !actionsOpen && <p className={`raid-proximity-status raid-proximity-status--${proximity.status}`} role="status">{proximityLabel}</p>}
  </section>
}
