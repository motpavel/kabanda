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
  const [inspectedPoint, setInspectedPoint] = useState<RaidMapPoint | null>(null)
  const [repeatPointId, setRepeatPointId] = useState<string | null>(null)
  const [selectedArrivalId, setSelectedArrivalId] = useState<string | null>(null)
  const inspectPoint = useCallback((point: RaidMapPoint) => { setInspectedPoint(point); setSheetOpen(false) }, [])
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
  const activePoint = raid.state === 'active' ? (proximity.nearby.find((point) => point.pointSnapshotId === selectedArrivalId &&
      (!point.creditedByMe || (point.pointSnapshotId === repeatPointId && !raid.routeTemplateId)))
    ?? proximity.nearby.find(({ creditedByMe }) => !creditedByMe) ?? null) : null
  const inspectedNearby = proximity.nearby.find((point) => point.pointSnapshotId === inspectedPoint?.id)
  // A delayed proximity response cannot undo an already confirmed map credit.
  const inspectedVisited = Boolean(inspectedNearby?.creditedByMe || inspectedPoint?.visitedByMe)
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
    if (activePoint.pointSnapshotId === lastPresentedPoint.current) return
    lastPresentedPoint.current = activePoint.pointSnapshotId
    setSheetOpen(true)
  }, [activePoint])

  useEffect(() => {
    if (!checkInAttention.actionKey) {
      lastPresentedAttention.current = ''
      return
    }
    if (checkInAttention.actionKey === lastPresentedAttention.current) return
    lastPresentedAttention.current = checkInAttention.actionKey
    setSheetOpen(true)
  }, [checkInAttention])

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

    <aside {...arrivalSheet} className="raid-arrival-sheet" aria-label={activePoint ? 'Подтверждение точки' : 'Сохранённые действия'}>
      <button className="raid-arrival-sheet__collapse" data-sheet-drag="true" aria-label="Свернуть подтверждение точки" onClick={() => setSheetOpen(false)} type="button"><span /></button>
      <div className="raid-arrival-sheet__heading" data-sheet-drag="true">
        <div><small>{activePoint ? 'ТОЧКА РЯДОМ' : 'ОТМЕТКИ'}</small><h2>{activePoint?.name ?? 'Сохранённые отметки'}</h2></div>
        {activePoint && <span className="raid-arrival-sheet__distance">{Math.round(activePoint.distanceMeters)}<small>метров</small></span>}
      </div>
      {!viewerIsOrganizer && activePoint && <p className="raid-arrival-sheet__waiting">Вы на месте. Подтвердите своё посещение.</p>}
      <CheckInPanel identityId={identityId} nearbyPoints={activePoint ? [activePoint] : []} onRefused={onCheckInRefused} onAttentionChange={setCheckInAttention} onCanonicalRefresh={onCanonicalRefresh} onPendingChange={setPendingCheckIns} presentation="map-sheet" raid={raid} staleProjection={staleProjection} repeatVisit={Boolean(repeatPointId && activePoint?.pointSnapshotId === repeatPointId && !raid.routeTemplateId)} onRepeatSaved={() => { setRepeatPointId(null); setSheetOpen(false) }} />
    </aside>

    {inspectedPoint && <aside hidden={actionsOpen} className="raid-point-history-sheet" aria-label={`История точки: ${inspectedPoint.name}`}>
      <header><h2>{inspectedPoint.name}</h2><button type="button" onClick={() => setInspectedPoint(null)}>Свернуть</button></header>
      {raid.routeTemplateId && inspectedVisited
        ? <p>Вы уже посетили эту точку в этом рейде. Продолжайте маршрут.</p>
        : raid.state === 'active' && inspectedNearby
          ? <button type="button" className="kb-primary raid-primary" disabled={pendingCheckIns > 0} onClick={() => {
            setRepeatPointId(inspectedVisited ? inspectedPoint.id : null)
            setSelectedArrivalId(inspectedPoint.id)
            setInspectedPoint(null)
            setSheetOpen(true)
          }}>{inspectedVisited ? 'Пометить ещё раз' : 'Пометить точку'}</button>
          : <p>{raid.state === 'paused' ? 'Чекины доступны после продолжения рейда.' : 'Для чекина подъедьте к точке на расстояние до 50 м.'}</p>}
      <PointVisitHistory key={`${identityId}:${inspectedPoint.sourcePointId}`} identityId={identityId} kabandaId={raid.kabandaId} pointId={inspectedPoint.sourcePointId} currentRaidId={raid.id} />
    </aside>}

    {raid.state === 'paused' && !actionsOpen && !inspectedPoint ? <section className="raid-paused-banner" aria-label="Рейд на паузе">
      <span className="raid-paused-banner__icon"><RaidControlIcon name="pause" /></span>
      <div><strong>Рейд на паузе</strong><p>{viewerIsOrganizer ? 'Запись и чекины приостановлены.' : 'Ждём, когда вожак продолжит рейд.'}</p></div>
      {serverPrimary?.kind === 'command' && serverPrimary.command === 'resume' && <button className="kb-primary" type="button" disabled={operationPending} onClick={onServerPrimary}><RaidControlIcon name="play" />{operationPending ? 'Продолжаем…' : 'Продолжить рейд'}</button>}
    </section> : raid.state === 'active' && !arrivalAvailable && !inspectedPoint && !actionsOpen && <p className={`raid-proximity-status raid-proximity-status--${proximity.status}`} role="status">{proximityLabel}</p>}
  </section>
}
