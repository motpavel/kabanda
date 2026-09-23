import { ResultSectionHeading } from './ResultSectionHeading'
import { useEffect, useMemo, useState } from 'react'
import { PointMaterialsPanel } from '../checkins/PointMaterialsPanel'
import { useRaidResource } from '../raids/resources'
import { completedPointsResource, materialsResource, COMPLETED_REFRESH_MS } from './view-resources'
import { RaidRouteMap } from '../raids/recording/RaidRouteMap'
import { isVisitedRaidPoint } from '../raids/recording/completed-route-view'
import type { FieldOperation } from '../raids/field-outbox'
import type { RaidMapPoint, RaidProjection } from '../raids/types'

export function CompletedRaidRoute({ identityId, raid, operations = [], canAddMaterials = false, staleOnly = false }: {
  identityId: string; raid: RaidProjection; operations?: readonly FieldOperation[]; canAddMaterials?: boolean; staleOnly?: boolean
}) {
  const entry = useMemo(() => completedPointsResource(identityId, raid.kabandaId, raid.id), [identityId, raid.kabandaId, raid.id])
  const state = useRaidResource(entry, !staleOnly, COMPLETED_REFRESH_MS, COMPLETED_REFRESH_MS)
  const points = state.data?.points?.filter(isVisitedRaidPoint) ?? []
  const [selected, setSelected] = useState<RaidMapPoint | null>(null)
  const fieldProtocol = state.data?.teamVisits === true
  useEffect(() => { setSelected(null) }, [identityId, raid.id])
  // One small metadata read after the main view settles. Never download images
  // speculatively or prefetch on a metered/slow connection.
  const firstPointId = points[0]?.id
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
    if (staleOnly || state.status !== 'ready' || !fieldProtocol || !firstPointId || connection?.saveData || /2g/.test(connection?.effectiveType ?? '')) return
    const timer = setTimeout(() => {
      if (!navigator.onLine || document.visibilityState !== 'visible') return
      const materials = materialsResource(identityId, raid.kabandaId, raid.id, firstPointId)
      void materials.refreshIfStale(COMPLETED_REFRESH_MS)
    }, 1200)
    return () => clearTimeout(timer)
  }, [identityId, raid.kabandaId, raid.id, firstPointId, fieldProtocol, state.status, staleOnly])

  return <section className="kb-card result-route" aria-label="Маршрут и посещения рейда">
    <ResultSectionHeading icon="route">Маршрут рейда</ResultSectionHeading>
    <div className="raid-active-map result-route__map">
      <RaidRouteMap identityId={identityId} raidId={raid.id} live={false} completed savedSnapshot={state.data} snapshotDenied={state.status === 'access-error'} snapshotVerified={!staleOnly && state.status === 'ready'} location={null} highlightedPointId={selected?.id ?? null} onSelectPoint={setSelected} />
    </div>
    {points.length > 0 && <>
      <h3>Посещённые точки</h3>
      <ol className="result-route__points">{points.map((point, index) => {
        const expanded = selected?.id === point.id
        return <li key={point.id}>
          <button className="result-route__point" type="button" aria-expanded={expanded} aria-controls={`result-point-${point.id}`} onClick={() => setSelected(expanded ? null : point)}>
            <span className="result-route__number">{index + 1}</span><strong>{point.name}</strong><svg className="result-route__chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
          </button>
          {expanded && <div id={`result-point-${point.id}`} className="result-route__history">
            {point.lastVisitedAt && <p className="result-route__time">Посетили <time dateTime={point.lastVisitedAt}>{new Date(point.lastVisitedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</time></p>}
            {fieldProtocol && <PointMaterialsPanel key={JSON.stringify([identityId, raid.id, point.id])}
              identityId={identityId} kabandaId={raid.kabandaId} raidId={raid.id} pointId={point.id}
              visible readOnly={staleOnly} compact completed={raid.state === 'completed'} actionsAtEnd commentsExpanded canWrite={canAddMaterials} operations={operations} />}
          </div>}
        </li>
      })}</ol>
    </>}
    {state.status === 'loading' && <p className="kb-muted" role="status">Загружаем посещённые точки…</p>}
    {state.message && <p className="kb-muted" role="status">{state.message} <button type="button" onClick={() => void state.refresh()}>Повторить</button></p>}
  </section>
}
