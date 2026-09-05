import { useCallback, useEffect, useRef, useState } from 'react'
import { listRaidTemplates } from './api'
import { appPath } from '../../lib/paths'
import { formatPlanDistance } from './editor/route-estimate'
import type { RaidTemplateSummary } from './types'
import { CachedImage, clearPrivateImageCache } from '../../lib/CachedImage'
import { ApiError } from '../../lib/http'

export function RaidTemplateCatalog({ kabandaId, identityId, active = true }: { kabandaId: string; identityId: string; active?: boolean }) {
  const requestVersion = useRef(0)
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; templates: RaidTemplateSummary[]; stale?: boolean }
    | { status: 'error' }
  >({ status: 'loading' })

  const load = useCallback(async () => {
    const version = ++requestVersion.current
    setState(current => current.status === 'ready' ? current : { status: 'loading' })
    try {
      const templates = await listRaidTemplates(kabandaId)
      if (requestVersion.current === version) setState({ status: 'ready', templates })
    } catch (error) {
      if (requestVersion.current !== version) return
      // Network failure may retain the current identity's picture; denial must not.
      if (error instanceof ApiError && error.status < 500) {
        clearPrivateImageCache()
        setState({ status: 'error' })
      } else setState(current => current.status === 'ready' ? { ...current, stale: true } : { status: 'error' })
    }
  }, [kabandaId])

  useEffect(() => {
    if (active) void load()
    return () => {
      requestVersion.current += 1
    }
  }, [active, load])

  useEffect(() => {
    const refresh = () => { if (active && document.visibilityState === 'visible' && navigator.onLine) void load() }
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [active, load])

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
    {state.status === 'ready' && state.stale && <p role="status">Сохранённые маршруты. Обновим после восстановления связи.</p>}
    {state.status === 'ready' && state.templates.length > 0 && <RaidTemplateGrid identityId={identityId} kabandaId={kabandaId} templates={state.templates} />}
  </section>
}

export function RaidTemplateGrid({ templates, kabandaId, identityId }: { templates: readonly RaidTemplateSummary[]; kabandaId?: string; identityId?: string }) {
  const chronological = [...templates].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
  return <div className="prd-template-grid">
    {chronological.map((template) => <a className="prd-template-card" key={template.id} href={`${appPath('app')}?createRaid=${encodeURIComponent(kabandaId ?? template.kabandaId)}&template=${encodeURIComponent(template.id)}`}>
      {identityId ? <CachedImage identityId={identityId} revision={template.cover.sha256} alt="" decoding="async" loading="lazy" src={template.cover.url} /> : <img alt="" decoding="async" loading="lazy" src={template.cover.url} />}
      <div>
        <h3>{template.title}</h3>
        <p>
          <span>{template.pointCount} {pointWord(template.pointCount)}</span>
          <span aria-hidden="true">·</span>
          <span>≈ {formatPlanDistance(template.estimate.distanceMeters)}</span>
        </p>
        <small>Расстояние по прямым отрезкам</small>
      </div>
    </a>)}
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
