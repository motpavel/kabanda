import { useEffect, useState } from 'react'
import { PointVisitHistory } from '../checkins/PointVisitHistory'
import { getRaidMapPoints } from '../raids/api'
import { RaidRouteMap } from '../raids/recording/RaidRouteMap'
import type { RaidMapPoint, RaidProjection } from '../raids/types'

export function CompletedRaidRoute({ identityId, raid }: { identityId: string; raid: RaidProjection }) {
  const [points, setPoints] = useState<RaidMapPoint[]>([])
  const [selected, setSelected] = useState<RaidMapPoint | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    void getRaidMapPoints(raid.id).then((next) => {
      if (active) setPoints(next.filter((point) => point.visitedByTeam))
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [raid.id])

  return <section className="kb-card result-route" aria-label="Маршрут и посещения рейда">
    <h2>Маршрут рейда</h2>
    <div className="raid-active-map result-route__map">
      <RaidRouteMap identityId={identityId} raidId={raid.id} live={false} completed location={null} highlightedPointId={null} onSelectPoint={setSelected} />
    </div>
    {points.length > 0 && <>
      <h3>Посещённые точки</h3>
      <ol className="result-route__points">{points.map((point) => <li key={point.id}>
        <button type="button" aria-pressed={selected?.id === point.id} onClick={() => setSelected(point)}>{point.name}<span aria-hidden="true">›</span></button>
      </li>)}</ol>
    </>}
    {failed && <p className="kb-muted">Список посещённых точек пока недоступен.</p>}
    {selected && <div className="result-route__history">
      <div className="kb-section-head"><h3>{selected.name}</h3><button type="button" aria-label="Закрыть посещения точки" onClick={() => setSelected(null)}>×</button></div>
      <PointVisitHistory key={selected.sourcePointId} identityId={identityId} kabandaId={raid.kabandaId} pointId={selected.sourcePointId} currentRaidId={raid.id} />
    </div>}
  </section>
}
