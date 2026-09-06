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
  const [actionsOpen, setActionsOpen] = useState(false)
  const [finishOpen, setFinishOpen] = useState(false)
  const actionsDialog = useRef<HTMLDialogElement>(null)
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
  const showRecovery = viewerIsNavigator && raid.state === 'active' && primary === 'recover'
  const recoveryLabel = recorder.phase === 'standby' ? 'Записывать на этом устройстве' : recorder.phase === 'blocked' ? 'Включить GPS' : 'Восстановить GPS'
  const hasCheckInAttention = checkInAttention.count > 0
  const arrivalAvailable = raid.state === 'active' && Boolean(activePoint || hasCheckInAttention)
  const recorderLabel = viewerIsNavigator ? ({
    fresh: 'Маршрут записывается',
    waiting: 'Ждём первую GPS-точку',
    recovering: 'Запускаем запись маршрута',
    stale: 'GPS давно не обновлялся',
    standby: 'Запись на другом устройстве',
    blocked: 'Нет доступа к геолокации',
    error: 'Запись маршрута остановлена',
    paused: 'Запись на паузе',
    ineligible: 'Запись недоступна',
  } as const)[recorder.phase] : null

  useEffect(() => {
    const dialog = actionsDialog.current
    if (actionsOpen) {
      if (!dialog?.open) dialog?.showModal()
    } else if (dialog?.open) {
      dialog.close()
      actionsTrigger.current?.focus({ preventScroll: true })
    }
  }, [actionsOpen])

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

    <dialog ref={actionsDialog} className="raid-active-map__actions" aria-labelledby="raid-actions-title" onCancel={() => setActionsOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) setActionsOpen(false) }}>
      {actionsOpen && <div className="raid-action-sheet">
        <header className="raid-action-sheet__header">
          <h2 id="raid-actions-title">{finishOpen ? 'Завершить рейд?' : 'Ваш рейд'}</h2>
          <button className="raid-icon-button" aria-label="Закрыть меню рейда" onClick={() => setActionsOpen(false)} type="button"><RaidControlIcon name="close" /></button>
        </header>
        {finishOpen ? <>
          <FinishRaidPanel presentation="sheet" identityId={identityId} raid={raid} flushRoute={recorder.flush} onApplyRaid={onApplyRaid} onCanonicalRefresh={onCanonicalRefresh} />
          <button className="raid-action-sheet__cancel" type="button" onClick={() => setFinishOpen(false)}>Вернуться к действиям</button>
        </> : <div className="raid-action-sheet__list">
          {serverActionAvailable && serverPrimary && <button className="raid-action-sheet__item" type="button" disabled={operationPending} onClick={onServerPrimary}><RaidControlIcon name={raid.state === 'paused' ? 'play' : 'pause'} /><span>{operationPending ? 'Подтверждаем…' : serverPrimary.label}</span></button>}
          {raid.allowedActions.includes('finish') && <button className="raid-action-sheet__item raid-action-sheet__item--finish" type="button" onClick={() => setFinishOpen(true)}><RaidControlIcon name="finish" /><span>Завершить рейд</span></button>}
          {!serverActionAvailable && !raid.allowedActions.includes('finish') && <p className="raid-action-sheet__hint">Пауза и завершение доступны вожаку рейда.</p>}
        </div>}
      </div>}
    </dialog>

    {!actionsOpen && (pageMessage || resourceError || (raid.state === 'active' && recorder.message) || showRecovery) && <section className="raid-active-map__notice" aria-label="Состояние активного рейда" data-phase={recorder.phase}>
      {resourceError && <p className="kb-error" role="alert">{resourceError}</p>}
      {pageMessage && <p className="kb-notice" role="status">{pageMessage}</p>}
      {raid.state === 'active' && recorder.message && <p className="kb-error" role="alert">{recorder.message}</p>}
      {showRecovery && <button className="kb-primary route-recorder__secondary" type="button" onClick={recorder.recover}>{recoveryLabel}</button>}
    </section>}

    {arrivalAvailable && !sheetOpen && !inspectedPoint && !actionsOpen && <button className="raid-arrival-pill" onClick={() => setSheetOpen(true)} type="button">
      <span aria-hidden="true" />
      <span><strong>{activePoint ? 'Вы рядом с точкой' : pendingCheckIns > 0 ? 'Сохранено без сети' : 'Нужно закончить отметку'}</strong><small>{activePoint ? `${activePoint.name} · ${Math.round(activePoint.distanceMeters)} м` : pendingCheckIns > 0 ? `${pendingCheckIns} действий ждут синхронизации` : 'Есть подтверждение или ручная проверка'}</small></span>
      <b>{activePoint ? 'Отметиться' : 'Открыть'}</b>
    </button>}

    <aside className="raid-arrival-sheet" aria-label={activePoint ? 'Подтверждение точки' : 'Сохранённые действия'} hidden={!sheetOpen || !arrivalAvailable || Boolean(inspectedPoint) || actionsOpen}>
      <button className="raid-arrival-sheet__collapse" aria-label="Свернуть подтверждение точки" onClick={() => setSheetOpen(false)} type="button"><span /></button>
      <div className="raid-arrival-sheet__heading">
        <div><small>{activePoint ? `Вы на точке · ${Math.round(activePoint.distanceMeters)} м` : 'Требуется действие'}</small><h2>{activePoint?.name ?? 'Завершите отметку'}</h2></div>
        <span className="raid-arrival-sheet__pulse" aria-hidden="true" />
      </div>
      {!viewerIsOrganizer && activePoint && <p className="raid-arrival-sheet__waiting">Вы на месте. Подтвердите своё посещение.</p>}
      <CheckInPanel identityId={identityId} nearbyPoints={activePoint ? [activePoint] : []} onAttentionChange={setCheckInAttention} onCanonicalRefresh={onCanonicalRefresh} onPendingChange={setPendingCheckIns} presentation="map-sheet" raid={raid} staleProjection={staleProjection} repeatVisit={Boolean(repeatPointId && activePoint?.pointSnapshotId === repeatPointId && !raid.routeTemplateId)} onRepeatSaved={() => { setRepeatPointId(null); setSheetOpen(false) }} />
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
          }}>{inspectedVisited ? 'Отметиться ещё раз' : 'Отметиться у точки'}</button>
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
