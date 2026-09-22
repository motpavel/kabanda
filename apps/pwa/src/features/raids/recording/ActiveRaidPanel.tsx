import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RaidPrimaryAction } from '../state'
import type { RaidMapPoint, RaidProjection } from '../types'
import type { CheckInResponse } from '../../checkins/types'
import { PointInfoSheet } from '../../checkins/PointInfoSheet'
import { ParticipantVisit } from '../../checkins/ParticipantVisit'
import { NavigatorVisitNotice } from '../../checkins/NavigatorVisitNotice'
import { newPersonalVisit } from '../../checkins/visit-notifications'
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
  onServerPrimary, onCanonicalRefresh, onApplyRaid, backHref, pageMessage, resourceError, navigatorControls,
}: {
  navigatorControls?: ReactNode
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
  const [visitNotice, setVisitNotice] = useState<RaidMapPoint | null>(null)
  const visitBaseline = useRef<{ key: string; visits: Map<string, string | null> | null }>({ key: '', visits: null })
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    const key = `${identityId}:${raid.id}`
    if (visitBaseline.current.key !== key) { visitBaseline.current = { key, visits: null }; setVisitNotice(null) }
    if (field.denied || !activeMember) { setVisitNotice(null); return }
    if (!field.data?.points) return
    const update = newPersonalVisit(field.data.points, visitBaseline.current.visits)
    visitBaseline.current.visits = update.next
    if (update.point && !viewerIsNavigator && activeMember) setVisitNotice(update.point)
  }, [identityId, raid.id, field.data?.points, field.denied, viewerIsNavigator, activeMember])
  const [sheetOpen, setSheetOpen] = useState(false)
  const [historyMaterialActions, setHistoryMaterialActions] = useState<HTMLDivElement | null>(null)
  const [arrivalMaterialActions, setArrivalMaterialActions] = useState<HTMLDivElement | null>(null)
  const [arrivalActions, setArrivalActions] = useState<HTMLDivElement | null>(null)
  const [checkInNotice, setCheckInNotice] = useState<{ text: string } | null>(null)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [finishOpen, setFinishOpen] = useState(false)
  const [navigatorOpen, setNavigatorOpen] = useState(false)
  const actionsTrigger = useRef<HTMLButtonElement>(null)
  const previousRaidState = useRef(raid.state)
  const [historyPoint, setHistoryPoint] = useState<RaidMapPoint | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [repeatPointId, setRepeatPointId] = useState<string | null>(null)
  const [selectedArrivalId, setSelectedArrivalId] = useState<string | null>(null)
  const [handledDestination, setHandledDestination] = useState('')
  const [stop, setStop] = useState<StopContext | null>(null)
  const [destinationBusy, setDestinationBusy] = useState(false)
  const [destinationError, setDestinationError] = useState<string | null>(null)
  const destinationAttempt = useRef<{ pointSnapshotId: string | null; expectedVersion: number; operationId: string } | null>(null)
  const destination = raid.destination ?? null
  const currentDestinationKey = destinationKey(destination)
  const [pendingCheckIns, setPendingCheckIns] = useState(0)
  const [checkInAttention, setCheckInAttention] = useState({ count: 0, key: '', actionKey: '' })
  const lastPresentedPoint = useRef<string | null>(null)
  const latestHistoryPoint = historyPoint ? field.data?.points?.find(point => point.id === historyPoint.id) ?? historyPoint : null
  const inspectedPoint = historyOpen ? latestHistoryPoint : null

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
    if (raid.state !== 'active' || !viewerIsNavigator || !activeMember) return null
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
  const inspectPoint = useCallback((point: RaidMapPoint) => {
    const near = nearby.find(item => item.pointSnapshotId === point.id)
    const visited = point.visitedByTeam || point.visitedByMe || near?.creditedByTeam || near?.creditedByMe
    if (viewerIsNavigator && activeMember && raid.state === 'active' && near && !visited) {
      setSelectedArrivalId(point.id)
      setRepeatPointId(null)
      setStop({ point: near, outsideSince: null, lastOutsideFix: null })
      setHistoryOpen(false)
      setSheetOpen(true)
      return
    }
    setHistoryPoint(point)
    setHistoryOpen(true)
    setSheetOpen(false)
  }, [nearby, viewerIsNavigator, activeMember, raid.state])
  const inspectedNearby = nearby.find(point => point.pointSnapshotId === latestHistoryPoint?.id)
  const inspectedDistance = inspectedNearby?.distanceMeters ?? (latestHistoryPoint && proximity.coordinate ? distanceMeters(proximity.coordinate, latestHistoryPoint) : null)
  const inspectedDistanceLabel = inspectedDistance === null ? null : inspectedDistance >= 1000
    ? { value: (inspectedDistance / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }), unit: 'км' }
    : { value: Math.round(inspectedDistance), unit: 'метров' }
  const serverNow = field.data?.serverAt && field.receivedAt ? Date.parse(field.data.serverAt) + Math.max(0, now - field.receivedAt) : now
  const repeatWait = Math.max(0, Math.ceil(((Date.parse(latestHistoryPoint?.repeatAvailableAt ?? '') || 0) - serverNow) / 1000))
  const inspectedVisited = Boolean(inspectedNearby?.creditedByTeam || latestHistoryPoint?.visitedByTeam ||
    inspectedNearby?.creditedByMe || latestHistoryPoint?.visitedByMe)
  const serverActionAvailable = serverPrimary?.kind === 'command' || serverPrimary?.kind === 'refresh'
  const primary = selectActivePrimaryAction(recorder.phase, serverActionAvailable)
  const showRecovery = viewerIsNavigator && raid.state === 'active' && primary === 'recover' && (recorder.phase === 'standby' || recorder.phase === 'error')
  const recoveryLabel = recorder.phase === 'standby' ? 'Продолжить запись здесь' : 'Повторить сохранение'
  const legacyAttention = Boolean(checkInAttention.actionKey)
  const showLegacy = viewerIsNavigator && (!fieldMode || (legacyAttention && !activePoint))
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
    if (!activePoint) return
    const key = `${activePoint.pointSnapshotId}:${repeatPointId ?? ''}:${currentDestinationKey}`
    if (key === lastPresentedPoint.current) return
    lastPresentedPoint.current = key
    if (activePoint.pointSnapshotId === destination?.pointSnapshotId || activePoint.pointSnapshotId === historyPoint?.id) setHistoryOpen(false)
    setSheetOpen(true)
  }, [activePoint?.pointSnapshotId, repeatPointId, currentDestinationKey, destination?.pointSnapshotId, historyPoint?.id])
  const refreshAfterCheckIn = useCallback(async () => {
    await onCanonicalRefresh()
    await proximity.refresh()
  }, [onCanonicalRefresh, proximity.refresh])
  const destinationIsArrival = Boolean(activePoint && activePoint.pointSnapshotId === destination?.pointSnapshotId)
  const repeatArrival = fieldMode ? Boolean(repeatPointId && activePoint?.pointSnapshotId === repeatPointId)
    : Boolean(!raid.routeTemplateId && activePoint?.creditedByMe && (destinationIsArrival || repeatPointId === activePoint.pointSnapshotId))
  const onCheckInSaved = useCallback(() => {
    if (destinationIsArrival) setHandledDestination(currentDestinationKey)
    setSelectedArrivalId(null); setRepeatPointId(null); setStop(null); setSheetOpen(false)
    void field.refresh(true).catch(() => undefined)
  }, [destinationIsArrival, currentDestinationKey, field.refresh])
  const onCheckInRefused = useCallback((text: string) => {
    setCheckInNotice({ text }); setSheetOpen(false); setRepeatPointId(null); setStop(null)
    void proximity.refresh()
  }, [proximity.refresh])
  const destinationFlight = useRef(false)
  const chooseDestination = async (clear = false) => {
    if ((!clear && !latestHistoryPoint) || destinationFlight.current || destinationBusy || staleProjection || !navigator.onLine || !viewerIsNavigator) return
    const target = clear ? null : latestHistoryPoint!.id
    if (!destinationAttempt.current || destinationAttempt.current.pointSnapshotId !== target) destinationAttempt.current = {
      pointSnapshotId: target, expectedVersion: raid.version, operationId: crypto.randomUUID(),
    }
    const attempt = destinationAttempt.current
    destinationFlight.current = true
    setDestinationBusy(true); setDestinationError(null)
    try {
      const next = await setRaidDestination(raid.id, { expectedVersion: attempt.expectedVersion, pointSnapshotId: attempt.pointSnapshotId }, attempt.operationId)
      destinationAttempt.current = null
      await onApplyRaid(next)
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) { destinationAttempt.current = null; void onCanonicalRefresh().catch(() => undefined) }
      setDestinationError(error instanceof ApiError && error.code === 'RAID_VERSION_CONFLICT' ? 'Цель рейда изменилась. Повторите выбор.' : 'Не удалось подтвердить цель. Попробуйте ещё раз.')
    } finally { destinationFlight.current = false; setDestinationBusy(false) }
  }
  const totalPending = pendingCheckIns + queue.pendingCount
  const proximityLabel = proximity.status === 'offline' ? 'Нет сети · маршрут сохраняется' : proximity.status === 'blocked'
    ? 'Разрешите геолокацию для поиска точек' : proximity.status === 'locating' ? 'Определяем ближайшую точку…'
      : fieldMode && !viewerIsNavigator ? 'Точки отмечает навигатор. Вы можете добавлять фото и комментарии.' : 'Едем дальше · ищем точку в радиусе 50 м'

  return <section className="raid-active-map" aria-label={`Активный рейд ${raid.title}`}>
    <RaidRouteMap identityId={identityId} navigatorUserId={raid.navigatorUserId} navigatorSampleAt={raid.routeStatus.lastSampleAt}
      localRoutePreview={viewerIsNavigator && recorder.phase === 'fresh'}
      planned={Boolean(raid.routeTemplateId)} destinationPointId={destination?.pointSnapshotId ?? null}
      highlightedPointId={activePoint?.pointSnapshotId ?? null} live={raid.state === 'active'} location={proximity.coordinate} raidId={raid.id} onSelectPoint={inspectPoint} onMapTap={() => { setSheetOpen(false); setHistoryOpen(false) }} />
    <NavigatorVisitNotice key={`${identityId}:${raid.id}`} identityId={identityId} raidId={raid.id}
      points={field.data?.points} enabled={viewerIsNavigator && activeMember && !field.denied && raid.state === 'active'}
      visible={!actionsOpen && !historyOpen && !(sheetOpen && arrivalAvailable)} onOpen={inspectPoint} />
    <span className="visit-toast-announcement" role="status" aria-atomic="true">{visitNotice ? `Вас отметили на точке ${visitNotice.name}${visitNotice.lastVisitedAt ? `, ${new Date(visitNotice.lastVisitedAt).toLocaleTimeString('ru-RU')}` : ''}` : ''}</span>
    {visitNotice && activeMember && !field.denied && !actionsOpen && !historyOpen && <section className="visit-toast" aria-label="Новая отметка">
      <button className="visit-toast__open" type="button" onClick={() => { inspectPoint(visitNotice); setVisitNotice(null) }}>
        <span className="visit-toast__icon" aria-hidden="true">✓</span><span><strong>Вас отметили на точке</strong><small>{visitNotice.name} · Фото и комментарий</small></span>
      </button><button className="visit-toast__close" aria-label="Закрыть уведомление об отметке" type="button" onClick={() => setVisitNotice(null)}>×</button>
    </section>}
    <header className="raid-active-map__header">
      <a aria-label="Выйти из карты рейда" href={backHref}><RaidControlIcon name="back" /></a>
      <div><small>{raid.state === 'paused' ? 'Рейд на паузе' : recorderLabel ?? 'Активный рейд'}</small><strong>{raid.title}</strong></div>
      <button ref={actionsTrigger} aria-haspopup="dialog" aria-expanded={actionsOpen} aria-label="Действия рейда" onClick={() => { setFinishOpen(false); setNavigatorOpen(false); setActionsOpen(true) }} type="button"><RaidControlIcon name="more" /></button>
    </header>
    <dialog {...actionsSheet} className="raid-active-map__actions" aria-labelledby="raid-actions-title" onClose={() => actionsTrigger.current?.focus({ preventScroll: true })}
      onCancel={event => { event.preventDefault(); setActionsOpen(false) }} onClick={event => { if (event.target === event.currentTarget) setActionsOpen(false) }}>
      <div className="raid-action-sheet">
        <button className="raid-sheet-grip" data-sheet-drag="true" aria-label="Свернуть действия рейда" onClick={() => setActionsOpen(false)} type="button"><span /></button>
        <header className="raid-action-sheet__header" data-sheet-drag="true"><h2 id="raid-actions-title">{navigatorOpen ? 'Навигатор рейда' : finishOpen ? 'Завершить рейд?' : 'Ваш рейд'}</h2></header>
        {navigatorOpen ? <>
          {navigatorControls || <p className="raid-action-sheet__hint">{viewerIsOrganizer ? 'Для передачи нужен другой активный участник и актуальные данные рейда. Проверьте соединение и дождитесь обновления состава.' : 'Сменить навигатора может вожак рейда. Попросите его выбрать другого участника в меню рейда.'}</p>}
          {pageMessage && <p role="status">{pageMessage}</p>}
          <button className="raid-action-sheet__cancel" type="button" onClick={() => setNavigatorOpen(false)}>Назад</button>
        </> : finishOpen ? <>
          <FinishRaidPanel presentation="sheet" identityId={identityId} raid={raid} flushRoute={recorder.flush} onApplyRaid={onApplyRaid} onCanonicalRefresh={onCanonicalRefresh} />
          <button className="raid-action-sheet__cancel" type="button" onClick={() => { setFinishOpen(false); setActionsOpen(false) }}>Нет, продолжить рейд</button>
        </> : <div className="raid-action-sheet__list">
          {serverActionAvailable && serverPrimary && <button className="raid-action-sheet__item" type="button" disabled={operationPending} onClick={onServerPrimary}><RaidControlIcon name={raid.state === 'paused' ? 'play' : 'pause'} /><span>{operationPending ? 'Подтверждаем…' : serverPrimary.label}</span></button>}
          {(viewerIsOrganizer || viewerIsNavigator) && <button className="raid-action-sheet__item" type="button" onClick={() => setNavigatorOpen(true)}><RaidControlIcon name="location" /><span>Сменить навигатора</span></button>}
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
      {raid.state === 'active' && recorder.message && <p className={recorder.phase === 'waiting' || recorder.phase === 'standby' ? 'raid-gps-waiting' : 'kb-error'} role={recorder.phase === 'waiting' || recorder.phase === 'standby' ? 'status' : 'alert'}>{recorder.message}</p>}
      {showRecovery && <button className="kb-primary route-recorder__secondary" type="button" onClick={() => {
        if (recorder.phase !== 'standby' || window.confirm('Продолжить запись здесь? На прежнем устройстве она остановится.')) recorder.recover()
      }}>{recoveryLabel}</button>}
    </section>}
    {arrivalAvailable && !sheetOpen && !inspectedPoint && !actionsOpen && <button className="raid-arrival-pill" onClick={() => setSheetOpen(true)} type="button"><span aria-hidden="true" />
      <span><strong>{activePoint ? 'Вы рядом с точкой' : totalPending > 0 ? 'Сохранённые действия' : 'Сохранённые отметки'}</strong><small>{activePoint ? `${activePoint.name} · ${Math.round(activePoint.distanceMeters)} м` : `${totalPending} действий ждут синхронизации`}</small></span><b>{activePoint ? 'Пометить' : 'Открыть'}</b>
    </button>}
    <aside {...arrivalSheet} className="raid-arrival-sheet raid-arrival-sheet--checkin" aria-label={activePoint ? 'Подтверждение точки' : 'Сохранённые действия'}>
      <button className="raid-arrival-sheet__collapse" data-sheet-drag="true" aria-label="Свернуть подтверждение точки" onClick={() => setSheetOpen(false)} type="button"><span /></button>
      <div className="raid-arrival-sheet__heading" data-sheet-drag="true"><div><h2>{activePoint?.name ?? (legacyAttention ? 'Проверка отметки' : 'Сохранённые действия')}</h2></div>
        {activePoint && <span className="raid-arrival-sheet__distance">{Math.round(activePoint.distanceMeters)}<small>метров</small></span>}</div>
      <div className="raid-arrival-sheet__body">
      {fieldMode && activePoint && viewerIsNavigator && !showLegacy && <TeamVisitPanel key={`${identityId}:${raid.id}:${activePoint.pointSnapshotId}:${repeatArrival ? activePoint.lastAttemptId ?? 'repeat' : 'first'}`}
        identityId={identityId} raid={raid} point={activePoint} positions={field.data?.positions ?? []} operations={queue.rows}
        actionContainer={arrivalActions} visible={sheetOpen} stale={staleProjection || field.denied} repeat={repeatArrival} onAccepted={onCheckInSaved} />}
      {viewerIsNavigator && <div hidden={fieldMode && !showLegacy}>
        <CheckInPanel key={`${identityId}:${raid.id}`} visible={sheetOpen && showLegacy} identityId={identityId}
          nearbyPoints={!fieldMode && activePoint ? [activePoint] : []} onRefused={onCheckInRefused} onAttentionChange={setCheckInAttention}
          actionContainer={arrivalActions} onCanonicalRefresh={refreshAfterCheckIn} onPendingChange={setPendingCheckIns} presentation="map-sheet" raid={raid}
          staleProjection={staleProjection} repeatVisit={!fieldMode && repeatArrival} onSaved={onCheckInSaved} />
      </div>}
      {fieldMode && activePoint && <PointMaterialsPanel compact actionContainer={arrivalMaterialActions} key={`arrival:${identityId}:${raid.id}:${activePoint.pointSnapshotId}`}
        identityId={identityId} kabandaId={raid.kabandaId} raidId={raid.id} pointId={activePoint.pointSnapshotId}
        visible={sheetOpen} canWrite={activeMember && !field.denied} operations={queue.rows} />}
      {fieldMode && !activePoint && totalPending > 0 && <p role="status">Сохранено на телефоне: {totalPending}. Отправка продолжится автоматически.</p>}
      </div>
      <div className="raid-arrival-sheet__footer"><div ref={setArrivalMaterialActions} /><div ref={setArrivalActions} />
        {destinationIsArrival && viewerIsNavigator && <button type="button" className="raid-destination-action" disabled={destinationBusy || staleProjection || !navigator.onLine} onClick={() => void chooseDestination(true)}>Отменить выбор</button>}
        {destinationIsArrival && destinationError && <p className="kb-error" role="alert">{destinationError}</p>}
      </div>
    </aside>
    <PointInfoSheet open={historyOpen && !actionsOpen} onClose={() => setHistoryOpen(false)} title={latestHistoryPoint?.name ?? ''} pointKey={latestHistoryPoint?.id}
      kicker={latestHistoryPoint?.id === destination?.pointSnapshotId ? 'ДВИГАЕМСЯ СЮДА' : undefined} distance={inspectedDistanceLabel}
      footer={<><div ref={setHistoryMaterialActions} />{latestHistoryPoint && raid.state === 'active' && activeMember && viewerIsNavigator && !(raid.routeTemplateId && inspectedVisited) ? <>
        {inspectedNearby ? <>
          {repeatWait > 0 && <p className="point-repeat-wait" aria-live="off">Повторная отметка через {Math.floor(repeatWait / 60)}:{String(repeatWait % 60).padStart(2, '0')}</p>}
          <button type="button" className="kb-primary raid-primary" disabled={totalPending > 0 || repeatWait > 0} onClick={() => {
            setRepeatPointId(inspectedVisited ? latestHistoryPoint.id : null); setSelectedArrivalId(latestHistoryPoint.id)
            setStop({ point: inspectedNearby, outsideSince: null, lastOutsideFix: null }); setHistoryOpen(false); setSheetOpen(true)
          }}>{inspectedVisited ? 'Пометить точку снова' : 'Пометить точку'}</button>
          {latestHistoryPoint.id === destination?.pointSnapshotId && <button type="button" className="raid-destination-action" disabled={destinationBusy || staleProjection || !navigator.onLine} onClick={() => void chooseDestination(true)}>Отменить выбор</button>}
          {destinationError && <p className="kb-error" role="alert">{destinationError}</p>}
        </> : <>
          {destinationError && <p className="kb-error" role="alert">{destinationError}</p>}
          <button type="button" className="raid-destination-action" disabled={destinationBusy || staleProjection || !navigator.onLine} onClick={() => void chooseDestination(latestHistoryPoint.id === destination?.pointSnapshotId)}>
            <RaidControlIcon name="pin" />{destinationBusy ? 'Выбираем цель…' : latestHistoryPoint.id === destination?.pointSnapshotId ? 'Отменить выбор' : 'Двигаться сюда'}
          </button>
        </>}
      </> : undefined}</>}>
      {latestHistoryPoint && <>
        {!viewerIsNavigator && <ParticipantVisit identityId={identityId} raid={raid} point={latestHistoryPoint} />}

        <section className="point-history-section" aria-label="История посещений">
          <h3>История посещений</h3>
          <PointVisitHistory key={`${identityId}:${latestHistoryPoint.sourcePointId}:${latestHistoryPoint.lastAttemptId ?? inspectedVisited}`} identityId={identityId} kabandaId={raid.kabandaId}
            pointId={latestHistoryPoint.sourcePointId} currentRaidId={raid.id} showHeading={false} onOpenRaid={() => setHistoryOpen(false)} active={historyOpen && !actionsOpen} />
        </section>
        {fieldMode && <PointMaterialsPanel compact actionContainer={historyMaterialActions} key={`history:${identityId}:${raid.id}:${latestHistoryPoint.id}`} identityId={identityId} kabandaId={raid.kabandaId}
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
