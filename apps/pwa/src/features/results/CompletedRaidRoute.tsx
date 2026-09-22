import { useEffect, useState } from 'react'
import { PointMaterialsPanel } from '../checkins/PointMaterialsPanel'
import { getRaidMapPoints, getRaidSnapshot } from '../raids/api'
import { RaidRouteMap } from '../raids/recording/RaidRouteMap'
import { isVisitedRaidPoint } from '../raids/recording/completed-route-view'
import type { FieldOperation } from '../raids/field-outbox'
import type { RaidMapPoint, RaidProjection } from '../raids/types'

export function CompletedRaidRoute({ identityId, raid, operations = [], canAddMaterials = false }: {
  identityId: string; raid: RaidProjection; operations?: readonly FieldOperation[]; canAddMaterials?: boolean
}) {
  const [points, setPoints] = useState<RaidMapPoint[]>([])
  const [selected, setSelected] = useState<RaidMapPoint | null>(null)
  const [failed, setFailed] = useState(false)
  const [fieldProtocol, setFieldProtocol] = useState(false)
  useEffect(() => {
    let active = true
    setPoints([]); setSelected(null); setFailed(false); setFieldProtocol(false)
    void getRaidSnapshot(raid.id).then(async snapshot => {
      const rows = snapshot.points ?? await getRaidMapPoints(raid.id)
      if (!active) return
      setFieldProtocol(snapshot.teamVisits === true)
      setPoints(rows.filter(isVisitedRaidPoint))
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [identityId, raid.id])

  return <section className="kb-card result-route" aria-label="Маршрут и посещения рейда">
    <h2>Маршрут рейда</h2>
    <div className="raid-active-map result-route__map">
      <RaidRouteMap identityId={identityId} raidId={raid.id} live={false} completed location={null} highlightedPointId={selected?.id ?? null} onSelectPoint={setSelected} />
    </div>
    {points.length > 0 && <>
      <h3>Посещённые точки</h3>
      <ol className="result-route__points">{points.map((point, index) => {
        const expanded = selected?.id === point.id
        return <li key={point.id}>
          <button className="result-route__point" type="button" aria-expanded={expanded} aria-controls={`result-point-${point.id}`} onClick={() => setSelected(expanded ? null : point)}>
            <span className="result-route__number">{index + 1}</span><strong>{point.name}</strong><span aria-hidden="true">{expanded ? '⌄' : '›'}</span>
          </button>
          {expanded && <div id={`result-point-${point.id}`} className="result-route__history">
            {point.lastVisitedAt && <p className="result-route__time">Посетили <time dateTime={point.lastVisitedAt}>{new Date(point.lastVisitedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</time></p>}
            {fieldProtocol && <PointMaterialsPanel key={JSON.stringify([identityId, raid.id, point.id])}
              identityId={identityId} kabandaId={raid.kabandaId} raidId={raid.id} pointId={point.id}
              visible compact actionsAtEnd canWrite={canAddMaterials} operations={operations} />}
          </div>}
        </li>
      })}</ol>
    </>}
    {failed && <p className="kb-muted">Список посещённых точек пока недоступен.</p>}
  </section>
}
