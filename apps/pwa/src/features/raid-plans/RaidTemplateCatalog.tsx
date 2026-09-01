import { useCallback, useEffect, useRef, useState } from 'react'
import { listRaidTemplates } from './api'
import { formatPlanDistance } from './editor/route-estimate'
import type { RaidTemplateSummary } from './types'

export function RaidTemplateCatalog({ kabandaId }: { kabandaId: string }) {
  const requestVersion = useRef(0)
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; templates: RaidTemplateSummary[] }
    | { status: 'error' }
  >({ status: 'loading' })

  const load = useCallback(async () => {
    const version = ++requestVersion.current
    setState({ status: 'loading' })
    try {
      const templates = await listRaidTemplates(kabandaId)
      if (requestVersion.current === version) setState({ status: 'ready', templates })
    } catch {
      if (requestVersion.current === version) setState({ status: 'error' })
    }
  }, [kabandaId])

  useEffect(() => {
    void load()
    return () => {
      requestVersion.current += 1
    }
  }, [load])

  return <section className="rdp-section prd-template-catalog" aria-labelledby="production-routes-heading" data-testid="production-route-catalog">
    <div className="prd-section-heading">
      <div>
        <h2 id="production-routes-heading">Доступные маршруты</h2>
        <p>Созданные участниками маршруты для будущих рейдов.</p>
      </div>
      {state.status === 'ready' && state.templates.length > 0 && <span>{state.templates.length}</span>}
    </div>
    {state.status === 'loading' && <div aria-label="Загружаем маршруты" className="prd-template-grid prd-template-grid--loading"><i /><i /></div>}
    {state.status === 'error' && <div className="prd-template-error" role="status">
      <span>Маршруты не загрузились.</span>
      <button onClick={() => void load()} type="button">Повторить</button>
    </div>}
    {state.status === 'ready' && state.templates.length === 0 && <div className="prd-template-empty">
      <strong>Маршрутов пока нет</strong>
      <span>Создайте первый: добавьте обложку и точки на карте.</span>
    </div>}
    {state.status === 'ready' && state.templates.length > 0 && <RaidTemplateGrid templates={state.templates} />}
  </section>
}

export function RaidTemplateGrid({ templates }: { templates: readonly RaidTemplateSummary[] }) {
  const chronological = [...templates].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
  return <div className="prd-template-grid">
    {chronological.map((template) => <article className="prd-template-card" key={template.id}>
      <img alt="" decoding="async" loading="lazy" src={template.cover.url} />
      <div>
        <h3>{template.title}</h3>
        <p>
          <span>{template.pointCount} {pointWord(template.pointCount)}</span>
          <span aria-hidden="true">·</span>
          <span>≈ {formatPlanDistance(template.estimate.distanceMeters)}</span>
        </p>
        <small>Расстояние по прямым отрезкам</small>
      </div>
    </article>)}
  </div>
}

function pointWord(count: number): string {
  const mod100 = count % 100
  const mod10 = count % 10
  if (mod100 >= 11 && mod100 <= 14) return 'точек'
  if (mod10 === 1) return 'точка'
  if (mod10 >= 2 && mod10 <= 4) return 'точки'
  return 'точек'
}
