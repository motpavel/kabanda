import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RaidPrimaryAction } from '../state'
import type { RaidMapPoint, RaidProjection } from '../types'
import type { CheckInResponse } from '../../checkins/types'
import { PointInfoSheet } from '../../checkins/PointInfoSheet'
import { PointVisitHistory } from '../../checkins/PointVisitHistory'
import { PointMaterialsPanel } from '../../checkins/PointMaterialsPanel'
import { TeamVisitPanel } from '../../checkins/TeamVisitPanel'
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
import { retainStop, type StopContext, type StopPoint } from './stop-context'
import { useLiveRaid } from '../use-live-raid'
import { useFieldQueue } from '../use-field-queue'

export function ActiveRaidPanel({ identityId, raid, staleProjection, serverPrimary, operationPending,
  onServerPrimary, onCanonicalRefresh, onApplyRaid, backHref, pageMessage, resourceError,
}: {
  identityId: string; raid: RaidProjection; staleProjection: boolean; serverPrimary: RaidPrimaryAction | null
  operationPending: boolean; onServerPrimary: () => void; onCanonicalRefresh: () => Promise<unknown>
  onApplyRaid: (raid: RaidProjection) => Promise<unknown>; backHref: string; pageMessage: string | null; resourceError: string | null
}) {
  const recorder = useRouteRecorder({ identityId, raid, staleProjection, onCanonicalRefresh, onApplyRaid })
  const activeMember = raid.participants.some(member => member.id === identityId && member.state === 'active')
  const proximity = useRaidProximity(identityId, raid.id, raid.state === 'active' && activeMember)
  const field = useLiveRaid(identityId, raid.id, raid.state === 'active' || raid.state === 'paused')
  const fieldMode = field.data?.teamVisits === true
  const queue = useFieldQueue(identityId, raid.id, raid.state)
  const viewerIsNavigator = raid.navigatorUserId === identityId
  const viewerIsOrganizer = raid.organizerUserId === identityId
  const [sheetOpen, setSheetOpen] = useState(false)
  const [checkInNotice, setCheckInNotice] = useState<{ text: string } | null>(null)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [finishOpen, setFinishOpen] = useState(false)
  const actionsTrigger = useRef<HTMLButtonElement>(null)
  const previousRaidState = useRef(raid.state)
  const [historyPoint, setHistoryPoint] = useState<RaidMapPoint | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [repeatPointId, setRepeatPointId] = useState<string | null>(null)
  const [selectedArrivalId, setSelectedArrivalId] = useState<string | null>(null)
  const [handledDestination, setHandledDestination] = useState('')
  const [stop, setStop] = useState<StopContext | null>(null)
  const [manualMode, setManualMode] = useState(false)
  const [legacyEpoch, setLegacyEpoch] = useState(0)
  const hadLegacyAttention = useRef(false)
  const [destinationBusy, setDestinationBusy] = useState(false)
  const [destinationError, setDestinationError] = useState<string | null>(null)
  const destinationAttempt = useRef<{ pointSnapshotId: string; expectedVersion: number; operationId: string } | null>(null)
  const destination = raid.destination ?? null
  const currentDestinationKey = destinationKey(destination)
  const [pendingCheckIns, setPendingCheckIns] = useState(0)
  const [checkInAttention, setCheckInAttention] = useState({ count: 0, key: '', actionKey: '' })
  const lastPresentedPoint = useRef<string | null>(null)
  const lastPresentedAttention = useRef('')
  const latestHistoryPoint = historyPoint ? field.data?.points?.find(point => point.id === historyPoint.id) ?? historyPoint : null
  const inspectedPoint = historyOpen ? latestHistoryPoint : null
  const inspectPoint = useCallback((point: RaidMapPoint) => { setHistoryPoint(point); setHistoryOpen(true); setSheetOpen(false) }, [])

  useEffect(() => {
    const next = field.data?.raid
    if (next && next.id === raid.id && next.version > raid.version) void onApplyRaid(next).catch(() => undefined)
  }, [field.data, raid.id, raid.version, onApplyRaid])
  useEffect(() => { if (field.denied) void onCanonicalRefresh().catch(() => undefined) }, [field.denied, onCanonicalRefresh])
  useEffect(() => { setSelectedArrivalId(null); setRepeatPointId(null); setStop(null) }, [currentDestinationKey, identityId, raid.id])
  useEffect(() => { setDestinationError(null) }, [historyPoint?.id])
  useEffect(() => {
    if (!checkInNotice) return
    const timer = setTimeout(() => setCheckInNotice(null), 10_000)
    return () => clearTimeout(timer)
  }, [checkInNotice])

  const nearby = useMemo<StopPoint[]>(() => {
    if (!fieldMode || !field.data?.points || !proximity.coordinate) return proximity.nearby
    const coordinate = proximity.coordinate
    const age = Date.now() - Date.parse(coordinate.capturedAt)
    if (age < -5000 || age > 30_000 || coordinate.accuracyMeters > 50) return []
    return field.data.points.map(point => ({ pointSnapshotId: point.id, sourcePointId: point.sourcePointId,
      name: point.name, latitude: point.latitude, longitude: point.longitude,
      distanceMeters: distanceMeters(coordinate, point), creditedByMe: point.visitedByMe,
      creditedByTeam: point.visitedByTeam, lastAttemptId: point.lastAttemptId ?? null }))
      .filter(point => point.distanceMeters <= 50).sort((a, b) => a.distanceMeters - b.distanceMeters)
  }, [fieldMode, field.data?.points, proximity.coordinate, proximity.nearby])
  const acknowledgedPoints = useMemo(() => new Set(queue.rows.filter(row => row.kind === 'team' && row.status === 'accepted'
    && (row.response as CheckInResponse | undefined)?.outcome === 'accepted').map(row => row.pointId)), [queue.rows])
  const candidate = useMemo<StopPoint | null>(() => {
    if (raid.state !== 'active') return null
    if (!fieldMode) return selectArrivalPoint({ nearby, planned: Boolean(raid.routeTemplateId), destination,
      handledDestination, selectedPointId: selectedArrivalId, repeatPointId })
    if (!viewerIsNavigator || !activeMember) return null
    const eligible = nearby.filter(point => (!point.creditedByTeam && !acknowledgedPoints.has(point.pointSnapshotId)) ||
      (!raid.routeTemplateId && point.pointSnapshotId === repeatPointId))
    const selected = eligible.find(point => point.pointSnapshotId === selectedArrivalId)
    if (selected) return selected
    if (destination && handledDestination !== currentDestinationKey) {
      const target = eligible.find(point => point.pointSnapshotId === destination.pointSnapshotId)
      if (target) return target
    }
    return eligible.find(point => !point.creditedByTeam && !acknowledgedPoints.has(point.pointSnapshotId)) ?? null
  }, [raid.state, raid.routeTemplateId, fieldMode, nearby, destination, handledDestination, selectedArrivalId,
    repeatPointId, viewerIsNavigator, activeMember, acknowledgedPoints, currentDestinationKey])
  useEffect(() => {
    if (!fieldMode || !viewerIsNavigator || !activeMember || raid.state !== 'active') { setStop(null); return }
    setStop(previous => {
      const confirmed = previous && (acknowledgedPoints.has(previous.point.pointSnapshotId) ||
        field.data?.points?.some(point => point.id === previous.point.pointSnapshotId && point.visitedByTeam))
      const current = confirmed && previous?.point.pointSnapshotId !== repeatPointId ? null : previous
      return retainStop(current, candidate, proximity.coordinate, Date.now(), selectedArrivalId !== null)
    })
  }, [fieldMode, viewerIsNavigator, activeMember, raid.state, acknowledgedPoints, field.data?.points, repeatPointId, candidate, proximity.coordinate, selectedArrivalId])
  const activePoint = fieldMode ? stop?.point ?? candidate : candidate
  const inspectedNearby = nearby.find(point => point.pointSnapshotId === latestHistoryPoint?.id)
  const inspectedDistance = inspectedNearby?.distanceMeters ?? (latestHistoryPoint && proximity.coordinate ? distanceMeters(proximity.coordinate, latestHistoryPoint) : null)
  const inspectedDistanceLabel = inspectedDistance === null ? null : inspectedDistance >= 1000
    ? { value: (inspectedDistance / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }), unit: 'км' }
    : { value: Math.round(inspectedDistance), unit: 'метров' }
  const inspectedVisited = Boolean(inspectedNearby?.creditedByTeam || latestHistoryPoint?.visitedByTeam ||
    inspectedNearby?.creditedByMe || latestHistoryPoint?.visitedByMe)
  const serverActionAvailable = serverPrimary?.kind === 'command' || serverPrimary?.kind === 'refresh'
  const primary = selectActivePrimaryAction(recorder.phase, serverActionAvailable)
  const showRecovery = viewerIsNavigator && raid.state === 'active' && primary === 'recover' && (recorder.phase === 'standby' || recorder.phase === 'error')
  const recoveryLabel = recorder.phase === 'standby' ? 'Записывать на этом устройстве' : 'Повторить сохранение'
  const legacyAttention = Boolean(checkInAttention.actionKey)
  const showLegacy = !fieldMode || manualMode || legacyAttention
  const arrivalAvailable = raid.state === 'active' && Boolean(activePoint || checkInAttention.count || queue.pendingCount)
  const actionsSheet = useSlideSheet<HTMLDialogElement>(actionsOpen, () => setActionsOpen(false))
  const arrivalSheet = useSlideSheet<HTMLElement>(sheetOpen && arrivalAvailable && !inspectedPoint && !actionsOpen, () => setSheetOpen(false))
  const recorderLabel = viewerIsNavigator ? ({ fresh: 'Маршрут записывается', waiting: 'Ищем GPS-сигнал', recovering: 'Запускаем запись маршрута',
    stale: 'GPS давно не обновлялся', standby: 'Запись на другом устройстве', blocked: 'Нет доступа к геолокации', error: 'Запись маршрута остановлена',
    paused: 'Запись на паузе', ineligible: 'Запись недоступна' } as const)[recorder.phase] : null

  useEffect(() => {
    if (previousRaidState.current !== raid.state) { setActionsOpen(false); setFinishOpen(false); previousRaidState.current = raid.state }
  }, [raid.state])
  useEffect(() => {
    if (!activePoint) { lastPresentedPoint.current = null; return }
    const key = `${activePoint.pointSnapshotId}:${repeatPointId ?? ''}:${currentDestinationKey}`
    if (key === lastPresentedPoint.current) return
    lastPresentedPoint.current = key
    if (activePoint.pointSnapshotId === destination?.pointSnapshotId) setHistoryOpen(false)
    setSheetOpen(true)
  }, [activePoint?.pointSnapshotId, repeatPointId, currentDestinationKey, destination?.pointSnapshotId])
  useEffect(() => {
    if (!checkInAttention.actionKey) {
      lastPresentedAttention.current = ''
      if (hadLegacyAttention.current) { setManualMode(false); hadLegacyAttention.current = false }
      return
    }
    hadLegacyAttention.current = true
    if (checkInAttention.actionKey === lastPresentedAttention.current) return
    lastPresentedAttention.current = checkInAttention.actionKey; setSheetOpen(true)
  }, [checkInAttention.actionKey])
  const refreshAfterCheckIn = useCallback(async () => {
    await onCanonicalRefresh()
    await proximity.refresh()
  }, [onCanonicalRefresh, proximity.refresh])
  const destinationIsArrival = Boolean(activePoint && activePoint.pointSnapshotId === destination?.pointSnapshotId)
  const repeatArrival = fieldMode ? Boolean(repeatPointId && activePoint?.pointSnapshotId === repeatPointId)
    : Boolean(!raid.routeTemplateId && activePoint?.creditedByMe && (destinationIsArrival || repeatPointId === activePoint.pointSnapshotId))
  const onCheckInSaved = useCallback(() => {
    if (destinationIsArrival) setHandledDestination(currentDestinationKey)
    setSelectedArrivalId(null); setRepeatPointId(null); setStop(null); setSheetOpen(false); setManualMode(false)
    void field.refresh(true).catch(() => undefined)
  }, [destinationIsArrival, currentDestinationKey, field.refresh])
  const onCheckInRefused = useCallback((text: string) => {
    setCheckInNotice({ text }); setSheetOpen(false); setRepeatPointId(null); setStop(null)
    void proximity.refresh()
  }, [proximity.refresh])
  const onManual = useCallback(() => { setManualMode(true); setLegacyEpoch(value => value + 1); setSheetOpen(true) }, [])
  const chooseDestination = async () => {
    if (!latestHistoryPoint || destinationBusy || staleProjection || !navigator.onLine || !viewerIsNavigator) return
    if (destinationAttempt.current?.pointSnapshotId !== latestHistoryPoint.id) destinationAttempt.current = {
      pointSnapshotId: latestHistoryPoint.id, expectedVersion: raid.version, operationId: crypto.randomUUID(),
    }
    const attempt = destinationAttempt.current
    setDestinationBusy(true); setDestinationError(null)
    try {
      const next = await setRaidDestination(raid.id, { expectedVersion: attempt.expectedVersion, pointSnapshotId: attempt.pointSnapshotId }, attempt.operationId)
      destinationAttempt.current = null
      await onApplyRaid(next)
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) { destinationAttempt.current = null; void onCanonicalRefresh().catch(() => undefined) }
      setDestinationError(error instanceof ApiError && error.code === 'RAID_VERSION_CONFLICT' ? 'Цель рейда изменилась. Повторите выбор.' : 'Не удалось подтвердить цель. Попробуйте ещё раз.')
    } finally { setDestinationBusy(false) }
  }
  const totalPending = pendingCheckIns + queue.pendingCount
  const proximityLabel = proximity.status === 'offline' ? 'Нет сети · маршрут сохраняется' : proximity.status === 'blocked'
    ? 'Разрешите геолокацию для поиска точек' : proximity.status === 'locating' ? 'Определяем ближайшую точку…'
      : fieldMode && !viewerIsNavigator ? 'Точки отмечает навигатор. Вы можете добавлять фото и комментарии.' : 'Едем дальше · ищем точку в радиусе 50 м'

  return <section className="raid-active-map" aria-label={`Активный рейд ${raid.title}`}>
    <RaidRouteMap identityId={identityId} navigatorUserId={raid.navigatorUserId} navigatorSampleAt={raid.routeStatus.lastSampleAt}
      planned={Boolean(raid.routeTemplateId)} destinationPointId={destination?.pointSnapshotId ?? null}
      highlightedPointId={activePoint?.pointSnapshotId ?? null} live={raid.state === 'active'} location={proximity.coordinate} raidId={raid.id} onSelectPoint={inspectPoint} />
    <header className="raid-active-map__header">
      <a aria-label="Выйти из карты рейда" href={backHref}><RaidControlIcon name="back" /></a>
      <div><small>{raid.state === 'paused' ? 'Рейд на паузе' : recorderLabel ?? 'Активный рейд'}</small><strong>{raid.title}</strong></div>
      <button ref={actionsTrigger} aria-haspopup="dialog" aria-expanded={actionsOpen} aria-label="Действия рейда" onClick={() => { setFinishOpen(false); setActionsOpen(true) }} type="button"><RaidControlIcon name="more" /></button>
    </header>
    <dialog {...actionsSheet} className="raid-active-map__actions" aria-labelledby="raid-actions-title" onClose={() => actionsTrigger.current?.focus({ preventScroll: true })}
      onCancel={event => { event.preventDefault(); setActionsOpen(false) }} onClick={event => { if (event.target === event.currentTarget) setActionsOpen(false) }}>
      <div className="raid-action-sheet">
        <button className="raid-sheet-grip" data-sheet-drag="true" aria-label="Свернуть действия рейда" onClick={() => setActionsOpen(false)} type="button"><span /></button>
        <header className="raid-action-sheet__header" data-sheet-drag="true"><h2 id="raid-actions-title">{finishOpen ? 'Завершить рейд?' : 'Ваш рейд'}</h2></header>
        {finishOpen ? <>
          <FinishRaidPanel presentation="sheet" identityId={identityId} raid={raid} flushRoute={recorder.flush} onApplyRaid={onApplyRaid} onCanonicalRefresh={onCanonicalRefresh} />
          <button className="raid-action-sheet__cancel" type="button" onClick={() => { setFinishOpen(false); setActionsOpen(false) }}>Нет, продолжить рейд</button>
        </> : <div className="raid-action-sheet__list">
          {serverActionAvailable && serverPrimary && <button className="raid-action-sheet__item" type="button" disabled={operationPending} onClick={onServerPrimary}><RaidControlIcon name={raid.state === 'paused' ? 'play' : 'pause'} /><span>{operationPending ? 'Подтверждаем…' : serverPrimary.label}</span></button>}
          {raid.allowedActions.includes('finish') && <button className="raid-action-sheet__item raid-action-sheet__item--finish" type="button" onClick={() => setFinishOpen(true)}><RaidControlIcon name="finish" /><span>Завершить рейд</span></button>}
          {!serverActionAvailable && !raid.allowedActions.includes('finish') && <p className="raid-action-sheet__hint">Пауза и завершение доступны вожаку рейда.</p>}
        </div>}
      </div>
    </dialog>
    {!actionsOpen && (checkInNotice || pageMessage || resourceError || queue.error || (raid.state === 'active' && recorder.message) || showRecovery) && <section className="raid-active-map__notice" aria-label="Состояние активного рейда" data-phase={recorder.phase}>
      {checkInNotice && <p className="raid-checkin-refusal" role="status">{checkInNotice.text}</p>}
      {resourceError && <p className="kb-error" role="alert">{resourceError}</p>}
      {pageMessage && <p className="kb-notice" role="status">{pageMessage}</p>}
      {queue.error && <p role="status">Не удалось проверить сохранённые действия. Не очищайте данные приложения.</p>}
      {raid.state === 'active' && recorder.message && <p className={recorder.phase === 'waiting' ? 'raid-gps-waiting' : 'kb-error'} role={recorder.phase === 'waiting' ? 'status' : 'alert'}>{recorder.message}</p>}
      {showRecovery && <button className="kb-primary route-recorder__secondary" type="button" onClick={recorder.recover}>{recoveryLabel}</button>}
    </section>}
    {arrivalAvailable && !sheetOpen && !inspectedPoint && !actionsOpen && <button className="raid-arrival-pill" onClick={() => setSheetOpen(true)} type="button"><span aria-hidden="true" />
      <span><strong>{activePoint ? 'Вы рядом с точкой' : totalPending > 0 ? 'Сохранённые действия' : 'Сохранённые отметки'}</strong><small>{activePoint ? `${activePoint.name} · ${Math.round(activePoint.distanceMeters)} м` : `${totalPending} действий ждут синхронизации`}</small></span><b>{activePoint ? 'Пометить' : 'Открыть'}</b>
    </button>}
    <aside {...arrivalSheet} className="raid-arrival-sheet raid-arrival-sheet--checkin" aria-label={activePoint ? 'Подтверждение точки' : 'Сохранённые действия'}>
      <button className="raid-arrival-sheet__collapse" data-sheet-drag="true" aria-label="Свернуть подтверждение точки" onClick={() => setSheetOpen(false)} type="button"><span /></button>
      <div className="raid-arrival-sheet__heading" data-sheet-drag="true"><div><h2>{activePoint?.name ?? 'Сохранённые отметки'}</h2></div>
        {activePoint && <span className="raid-arrival-sheet__distance">{Math.round(activePoint.distanceMeters)}<small>метров</small></span>}</div>
      {fieldMode && activePoint && viewerIsNavigator && !showLegacy && <TeamVisitPanel key={`${identityId}:${raid.id}:${activePoint.pointSnapshotId}:${repeatArrival ? activePoint.lastAttemptId ?? 'repeat' : 'first'}`}
        identityId={identityId} raid={raid} point={activePoint} positions={field.data?.positions ?? []} operations={queue.rows}
        visible={sheetOpen} stale={staleProjection || field.denied} repeat={repeatArrival} onAccepted={onCheckInSaved} onManual={onManual} />}
      <div hidden={fieldMode && !showLegacy}>
        <CheckInPanel key={`${identityId}:${raid.id}:${legacyEpoch}`} visible={sheetOpen && showLegacy} identityId={identityId}
          nearbyPoints={!fieldMode && activePoint ? [activePoint] : []} onRefused={onCheckInRefused} onAttentionChange={setCheckInAttention}
          onCanonicalRefresh={refreshAfterCheckIn} onPendingChange={setPendingCheckIns} presentation="map-sheet" raid={raid}
          staleProjection={staleProjection} repeatVisit={!fieldMode && repeatArrival} onSaved={onCheckInSaved} />
      </div>
      {fieldMode && activePoint && <PointMaterialsPanel compact key={`arrival:${identityId}:${raid.id}:${activePoint.pointSnapshotId}`}
        identityId={identityId} kabandaId={raid.kabandaId} raidId={raid.id} pointId={activePoint.pointSnapshotId}
        visible={sheetOpen} canWrite={activeMember && !field.denied} operations={queue.rows} />}
      {fieldMode && !activePoint && totalPending > 0 && <p role="status">Сохранено на телефоне: {totalPending}. Отправка продолжится автоматически.</p>}
    </aside>
    <PointInfoSheet open={historyOpen && !actionsOpen} onClose={() => setHistoryOpen(false)} title={latestHistoryPoint?.name ?? ''}
      kicker={latestHistoryPoint?.id === destination?.pointSnapshotId ? 'ДВИГАЕМСЯ СЮДА' : undefined} distance={inspectedDistanceLabel}>
      {latestHistoryPoint && <>
        <PointVisitHistory key={`${identityId}:${latestHistoryPoint.sourcePointId}:${inspectedVisited}`} identityId={identityId} kabandaId={raid.kabandaId}
          pointId={latestHistoryPoint.sourcePointId} currentRaidId={raid.id} onOpenRaid={() => setHistoryOpen(false)} active={historyOpen && !actionsOpen} />
        {raid.state === 'active' && activeMember && (!fieldMode || viewerIsNavigator) && inspectedNearby && !(raid.routeTemplateId && inspectedVisited) && <div className="raid-point-history-sheet__action">
          <button type="button" className="kb-primary raid-primary" disabled={totalPending > 0} onClick={() => {
            setRepeatPointId(inspectedVisited ? latestHistoryPoint.id : null); setSelectedArrivalId(latestHistoryPoint.id)
            setStop({ point: inspectedNearby, outsideSince: null, lastOutsideFix: null }); setHistoryOpen(false); setSheetOpen(true); setManualMode(false)
          }}>{fieldMode && inspectedVisited ? 'Новый визит на эту точку' : 'Пометить точку'}</button>
        </div>}
        {raid.state === 'active' && !inspectedNearby && viewerIsNavigator && !(raid.routeTemplateId && inspectedVisited) && <div className="raid-point-history-sheet__action">
          {destinationError && <p className="kb-error" role="alert">{destinationError}</p>}
          <button type="button" className="raid-destination-action" disabled={destinationBusy || staleProjection || !navigator.onLine || latestHistoryPoint.id === destination?.pointSnapshotId} onClick={() => void chooseDestination()}>
            <RaidControlIcon name="pin" />{destinationBusy ? 'Выбираем цель…' : latestHistoryPoint.id === destination?.pointSnapshotId ? 'Двигаемся сюда' : 'Двигаться сюда'}
          </button>
        </div>}
        {fieldMode && <PointMaterialsPanel compact key={`history:${identityId}:${raid.id}:${latestHistoryPoint.id}`} identityId={identityId} kabandaId={raid.kabandaId}
          raidId={raid.id} pointId={latestHistoryPoint.id} visible={historyOpen && !actionsOpen} canWrite={activeMember && !field.denied} operations={queue.rows} />}
      </>}
    </PointInfoSheet>
    {destination && raid.state === 'active' && !arrivalAvailable && !inspectedPoint && !actionsOpen && <button className="raid-arrival-pill raid-destination-pill" type="button" onClick={() => inspectPoint(field.data?.points?.find(point => point.id === destination.pointSnapshotId) ?? {
      id: destination.pointSnapshotId, sourcePointId: destination.sourcePointId, name: destination.name, latitude: destination.latitude, longitude: destination.longitude, position: 0, visitedByMe: false, visitedByTeam: false,
    })}><RaidControlIcon name="pin" /><span><strong>Двигаемся сюда</strong><small>{destination.name}</small></span><b aria-hidden="true">›</b></button>}
    {raid.state === 'paused' && !actionsOpen && !inspectedPoint ? <section className="raid-paused-banner" aria-label="Рейд на паузе">
      <span className="raid-paused-banner__icon"><RaidControlIcon name="pause" /></span><div><strong>Рейд на паузе</strong><p>{viewerIsOrganizer ? 'Запись и чекины приостановлены.' : 'Ждём, когда вожак продолжит рейд.'}</p></div>
      {serverPrimary?.kind === 'command' && serverPrimary.command === 'resume' && <button className="kb-primary" type="button" disabled={operationPending} onClick={onServerPrimary}><RaidControlIcon name="play" />{operationPending ? 'Продолжаем…' : 'Продолжить рейд'}</button>}
    </section> : raid.state === 'active' && !destination && !arrivalAvailable && !inspectedPoint && !actionsOpen && <p className={`raid-proximity-status raid-proximity-status--${proximity.status}`} role="status">{proximityLabel}</p>}
  </section>
}
