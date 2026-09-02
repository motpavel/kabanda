import { useEffect, useRef, useState } from 'react'
import type { RaidPrimaryAction } from '../state'
import type { RaidProjection } from '../types'
import { selectActivePrimaryAction } from './state'
import { useRouteRecorder } from './useRouteRecorder'
import { CheckInPanel } from '../../checkins/CheckInPanel'
import { FinishRaidPanel } from '../../results/FinishRaidPanel'
import { RaidRouteMap } from './RaidRouteMap'
import { useRaidProximity } from './useRaidProximity'

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
}) {
  const recorder = useRouteRecorder({ identityId, raid, staleProjection, onCanonicalRefresh, onApplyRaid })
  const proximity = useRaidProximity(raid.id, raid.state === 'active')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [pendingCheckIns, setPendingCheckIns] = useState(0)
  const lastPresentedPoint = useRef<string | null>(null)
  const activePoint = proximity.nearby.find(({ creditedByTeam }) => !creditedByTeam) ?? null
  const viewerIsOrganizer = raid.organizerUserId === identityId
  const serverActionAvailable = serverPrimary?.kind === 'command' || serverPrimary?.kind === 'refresh'
  const primary = selectActivePrimaryAction(recorder.phase, serverActionAvailable)

  useEffect(() => {
    if (!activePoint || activePoint.pointSnapshotId === lastPresentedPoint.current) return
    lastPresentedPoint.current = activePoint.pointSnapshotId
    setSheetOpen(true)
  }, [activePoint])

  const proximityLabel = proximity.status === 'offline'
    ? 'Нет сети · маршрут сохраняется'
    : proximity.status === 'blocked'
      ? 'Разрешите геолокацию для поиска точек'
      : proximity.status === 'locating'
        ? 'Определяем ближайшую точку…'
        : 'Едем дальше · ищем точку в радиусе 50 м'

  return <section className="raid-active-map" aria-label={`Активный рейд ${raid.title}`}>
    <RaidRouteMap
      highlightedPointId={activePoint?.pointSnapshotId ?? null}
      live={raid.state === 'active'}
      location={proximity.coordinate}
      raidId={raid.id}
    />

    <header className="raid-active-map__header">
      <a aria-label="Выйти из карты рейда" href={backHref}>←</a>
      <div><small>{raid.state === 'paused' ? 'Рейд на паузе' : 'Активный рейд'}</small><strong>{raid.title}</strong></div>
      <button aria-expanded={actionsOpen} aria-label="Действия рейда" onClick={() => setActionsOpen((value) => !value)} type="button">•••</button>
    </header>

    {actionsOpen && <aside className="raid-active-map__actions" aria-label="Действия рейда">
      <button className="raid-active-map__actions-close" onClick={() => setActionsOpen(false)} type="button">Закрыть</button>
      {(recorder.message || primary === 'recover' || (primary === 'server' && serverPrimary)) && <section aria-label="Управление записью маршрута" className="route-recorder" data-phase={recorder.phase}>
        {recorder.message && <p className="kb-error" role="alert">{recorder.message}</p>}
        {primary === 'recover' && <button className="kb-link-button route-recorder__secondary" type="button" onClick={recorder.recover}>{recorder.phase === 'standby' ? 'Продолжить здесь' : 'Возобновить запись'}</button>}
        {primary === 'server' && serverPrimary && <button className="kb-primary raid-primary" type="button" disabled={operationPending} onClick={onServerPrimary}>{operationPending ? 'Подтверждаем…' : serverPrimary.label}</button>}
      </section>}
      {(raid.state === 'active' || raid.state === 'paused') && <FinishRaidPanel identityId={identityId} raid={raid} flushRoute={recorder.flush} onApplyRaid={onApplyRaid} onCanonicalRefresh={onCanonicalRefresh} />}
    </aside>}

    {(activePoint || pendingCheckIns > 0) && !sheetOpen && <button className="raid-arrival-pill" onClick={() => setSheetOpen(true)} type="button">
      <span aria-hidden="true" />
      <span><strong>{activePoint ? 'Вы рядом с точкой' : 'Сохранено без сети'}</strong><small>{activePoint ? `${activePoint.name} · ${Math.round(activePoint.distanceMeters)} м` : `${pendingCheckIns} действий ждут синхронизации`}</small></span>
      <b>{activePoint ? 'Отметиться' : 'Открыть'}</b>
    </button>}

    <aside className="raid-arrival-sheet" aria-label={activePoint ? 'Подтверждение точки' : 'Сохранённые действия'} hidden={!sheetOpen || (!activePoint && pendingCheckIns === 0)}>
      <button className="raid-arrival-sheet__collapse" aria-label="Свернуть подтверждение точки" onClick={() => setSheetOpen(false)} type="button"><span /></button>
      <div className="raid-arrival-sheet__heading">
        <div><small>{activePoint ? `Вы на точке · ${Math.round(activePoint.distanceMeters)} м` : 'Офлайн-очередь'}</small><h2>{activePoint?.name ?? 'Сохранённые действия'}</h2></div>
        <span className="raid-arrival-sheet__pulse" aria-hidden="true" />
      </div>
      {!viewerIsOrganizer && activePoint && <p className="raid-arrival-sheet__waiting">Вы на месте. Организатор подтвердит состав группы.</p>}
      <CheckInPanel identityId={identityId} nearbyPoints={activePoint ? [activePoint] : []} onCanonicalRefresh={onCanonicalRefresh} onPendingChange={setPendingCheckIns} presentation="map-sheet" raid={raid} staleProjection={staleProjection} />
    </aside>

    {!activePoint && pendingCheckIns === 0 && <p className={`raid-proximity-status raid-proximity-status--${proximity.status}`} role="status">{proximityLabel}</p>}
  </section>
}
