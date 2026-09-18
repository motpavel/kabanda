import { useEffect, useState } from 'react'
import { appPath } from '../../lib/paths'
import { CachedImage } from '../../lib/CachedImage'
import { RiderLoader } from '../../app/RiderLoader'
import { getRaidTemplate } from './api'
import { formatPlanDistance } from './editor/route-estimate'
import type { RaidTemplate, RaidTemplateSummary } from './types'
import { pointWord } from './RaidTemplateCatalog'
import './route-detail.css'

export function RoutePreview({ template, identityId, kabandaId }: { template: RaidTemplateSummary; identityId: string; kabandaId: string }) {
  return <article className="route-preview">
    <CachedImage identityId={identityId} revision={template.cover.sha256} src={template.cover.url} alt={`Обложка маршрута «${template.title}»`} />
    <div><strong>{template.title}</strong><span>{template.pointCount} {pointWord(template.pointCount)} · ≈ {formatPlanDistance(template.estimate.distanceMeters)}</span>
      {template.description && <p>{template.description}</p>}
      <a href={`${appPath('app')}?routeTemplate=${encodeURIComponent(template.id)}&kabanda=${encodeURIComponent(kabandaId)}`}>Подробнее о маршруте</a>
    </div>
  </article>
}

export function RaidTemplateDetail({ templateId, identityId, kabandaId }: { templateId: string; identityId: string; kabandaId: string }) {
  const [state, setState] = useState<{ template?: RaidTemplate; error?: boolean }>({})
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    setState({})
    void getRaidTemplate(templateId).then(({ template }) => { if (current) setState({ template }) }).catch(() => { if (current) setState({ error: true }) })
    return () => { current = false }
  }, [identityId, templateId, attempt])
  const template = state.template
  return <article className="route-detail">
    <a className="raid-back" href={`${appPath('app')}?tab=raids&kabanda=${encodeURIComponent(kabandaId)}`}>← Доступные маршруты</a>
    {!template && !state.error && <RiderLoader label="Загружаем маршрут" />}
    {state.error && <div className="route-detail__section" role="status"><h1>Маршрут недоступен</h1><p>Проверьте соединение и доступ к маршруту.</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Повторить</button></div>}
    {template && <>
      <CachedImage className="route-detail__cover" identityId={identityId} revision={template.cover.sha256} src={template.cover.url} alt={`Обложка маршрута «${template.title}»`} />
      <header><p className="route-detail__eyebrow">Маршрут Кабанды</p><h1>{template.title}</h1><div className="route-detail__metrics"><span>{template.pointCount} {pointWord(template.pointCount)}</span><span>≈ {formatPlanDistance(template.estimate.distanceMeters)}</span></div><small>Расстояние по прямым отрезкам между точками</small></header>
      <section className="route-detail__section"><h2>О маршруте</h2><p className="route-detail__description">{template.description?.trim() || 'Автор пока не добавил описание. Ниже — все точки в порядке поездки.'}</p></section>
      <section className="route-detail__section"><h2>Что по пути</h2><ol className="route-detail__points">{[...template.points].sort((a, b) => a.position - b.position).map(point => <li key={point.id}><div><strong>{point.name}</strong><span>{point.address}</span>{point.comment && <p>{point.comment}</p>}</div></li>)}</ol></section>
      <div className="route-detail__action"><a className="kb-primary" href={`${appPath('app')}?createRaid=${encodeURIComponent(kabandaId)}&template=${encodeURIComponent(template.id)}`}>Отправиться</a></div>
    </>}
  </article>
}
