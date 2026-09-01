import '@fontsource-variable/manrope'
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react'
import { listKabandas } from '../../kabandas/api'
import type { KabandaSummary } from '../../kabandas/types'
import { ApiError } from '../../../lib/http'
import { appPath } from '../../../lib/paths'
import { createRaidTemplate, reverseGeocodeTemplatePoint } from '../api'
import {
  RAID_TEMPLATE_MAX_POINTS,
  type DraftRaidTemplatePoint,
  type DraftRouteEstimate,
  type RaidTemplateDraft,
} from '../types'
import { type BicycleRouteState, type RaidPlanGeoPoint } from '../yandex-adapter'
import {
  clearRaidTemplateDraft,
  createRaidTemplateDraft,
  readRaidTemplateDraft,
  saveRaidTemplateDraft,
} from './draft-store'
import { formatPlanDistance, geodesicRouteDistance } from './route-estimate'
import { prepareRaidTemplateCover } from './prepare-cover'
import {
  raidTemplateDraftErrors,
  raidTemplateDraftReducer,
} from './reducer'
import { RaidTemplateEditorMap } from './RaidTemplateEditorMap'
import { RaidTemplatePointList } from './RaidTemplatePointList'
import { RaidTemplatePointSheet } from './RaidTemplatePointSheet'
import './raid-template-editor.css'

export function RaidTemplateEditorRoute({ identityId, kabandaId }: { identityId: string; kabandaId: string }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; kabanda: KabandaSummary }
    | { status: 'missing' }
    | { status: 'error' }
  >({ status: 'loading' })

  useEffect(() => {
    let active = true
    listKabandas().then((kabandas) => {
      if (!active) return
      const kabanda = kabandas.find((item) => item.id === kabandaId)
      setState(kabanda ? { status: 'ready', kabanda } : { status: 'missing' })
    }).catch(() => active && setState({ status: 'error' }))
    return () => {
      active = false
    }
  }, [kabandaId])

  if (state.status === 'loading') return <EditorShell kabandaId={kabandaId}><div className="rt-editor-state" aria-busy="true">Открываем конструктор…</div></EditorShell>
  if (state.status === 'missing') return <EditorShell kabandaId={kabandaId}><EditorError title="Кабанда недоступна" detail="Создавать маршруты могут только её активные участники." /></EditorShell>
  if (state.status === 'error') return <EditorShell kabandaId={kabandaId}><EditorError title="Не удалось проверить участие" detail="Подключитесь к интернету и откройте конструктор ещё раз." /></EditorShell>
  return <RaidTemplateEditor identityId={identityId} kabanda={state.kabanda} />
}

function RaidTemplateEditor({ identityId, kabanda }: { identityId: string; kabanda: KabandaSummary }) {
  const [initialDraft] = useState(() => {
    const restored = readRaidTemplateDraft(identityId, kabanda.id)
    return {
      draft: restored ?? createRaidTemplateDraft(identityId, kabanda.id),
      restored: restored !== null,
    }
  })
  const [draft, dispatch] = useReducer(
    raidTemplateDraftReducer,
    initialDraft.draft,
  )
  const draftRef = useRef(draft)
  const routeTimeoutRef = useRef<number | null>(null)
  const [routeEstimate, setRouteEstimate] = useState<DraftRouteEstimate>({ status: 'idle' })
  const [localState, setLocalState] = useState<'saving' | 'saved' | 'failed'>(initialDraft.restored ? 'saved' : 'saving')
  const [coverState, setCoverState] = useState<'idle' | 'processing'>('idle')
  const [coverError, setCoverError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [pointSheetHeight, setPointSheetHeight] = useState(0)
  const coordinateFingerprint = draft.points.map((point) => `${point.latitude}:${point.longitude}`).join('|')
  const selectedPoint = draft.points.find((point) => point.clientId === draft.selectedPointId) ?? null
  const selectedPointNumber = selectedPoint ? draft.points.findIndex((point) => point.clientId === selectedPoint.clientId) + 1 : 0
  const validationErrors = raidTemplateDraftErrors(draft)
  const summary = estimateSummary(routeEstimate)
  draftRef.current = draft

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine)
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)
    return () => {
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOnline)
    }
  }, [])

  useEffect(() => {
    setLocalState('saving')
    const timer = window.setTimeout(() => {
      setLocalState(saveRaidTemplateDraft(draft) ? 'saved' : 'failed')
    }, 250)
    return () => window.clearTimeout(timer)
  }, [draft])

  useEffect(() => {
    if (routeTimeoutRef.current !== null) window.clearTimeout(routeTimeoutRef.current)
    if (draft.points.length < 2) {
      setRouteEstimate({ status: 'idle' })
      return
    }
    const fallbackDistanceMeters = geodesicRouteDistance(draft.points)
    setRouteEstimate({ status: 'calculating', fallbackDistanceMeters })
    routeTimeoutRef.current = window.setTimeout(() => {
      setRouteEstimate({ status: 'degraded', distanceMeters: fallbackDistanceMeters, failureCode: 'provider_unavailable' })
    }, 15_000)
    return () => {
      if (routeTimeoutRef.current !== null) window.clearTimeout(routeTimeoutRef.current)
    }
    // Only coordinate/order changes make the current route estimate stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordinateFingerprint])

  const requestGeocode = useCallback(async (point: Pick<DraftRaidTemplatePoint, 'clientId' | 'latitude' | 'longitude'>) => {
    const requestId = randomId()
    dispatch({ type: 'start-geocode', pointId: point.clientId, requestId })
    try {
      const suggestion = await reverseGeocodeTemplatePoint(point.latitude, point.longitude)
      if (!suggestion.name && !suggestion.address) {
        dispatch({ type: 'fail-geocode', pointId: point.clientId, requestId })
        return
      }
      dispatch({
        type: 'resolve-geocode',
        pointId: point.clientId,
        requestId,
        name: suggestion.name,
        address: suggestion.address,
      })
    } catch {
      dispatch({ type: 'fail-geocode', pointId: point.clientId, requestId })
    }
  }, [])

  useEffect(() => {
    for (const point of draftRef.current.points) {
      if (point.geocodeStatus === 'pending') void requestGeocode(point)
    }
  }, [requestGeocode])

  const addPoint = useCallback((coordinates: RaidPlanGeoPoint) => {
    const current = draftRef.current
    if (current.points.length >= RAID_TEMPLATE_MAX_POINTS) return
    const point: DraftRaidTemplatePoint = {
      clientId: randomId(),
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      name: `Точка ${current.points.length + 1}`,
      address: '',
      comment: '',
      geocodeStatus: 'pending',
      geocodeRequestId: null,
      labelsConfirmed: false,
    }
    dispatch({ type: 'add-point', point })
    void requestGeocode(point)
  }, [requestGeocode])

  const handleRouteState = useCallback((state: BicycleRouteState) => {
    if (routeTimeoutRef.current !== null) window.clearTimeout(routeTimeoutRef.current)
    if (state.status === 'calculating') {
      const fallbackDistanceMeters = Math.round(state.fallbackDistanceMeters)
      setRouteEstimate({ status: 'calculating', fallbackDistanceMeters })
      routeTimeoutRef.current = window.setTimeout(() => {
        setRouteEstimate({ status: 'degraded', distanceMeters: fallbackDistanceMeters, failureCode: 'provider_unavailable' })
      }, 15_000)
      return
    }
    if (state.status === 'ready') {
      setRouteEstimate({ status: 'ready', distanceMeters: Math.round(state.distanceMeters) })
      return
    }
    setRouteEstimate({
      status: 'degraded',
      distanceMeters: Math.round(state.fallbackDistanceMeters),
      failureCode: state.code,
    })
  }, [])

  const prepareCover = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setCoverState('processing')
    setCoverError(null)
    try {
      dispatch({ type: 'set-cover', coverImage: await prepareRaidTemplateCover(file) })
    } catch (error) {
      setCoverError(error instanceof Error ? error.message : 'Не удалось подготовить обложку.')
    } finally {
      setCoverState('idle')
    }
  }

  const deletePoint = (pointId: string) => {
    if (!window.confirm('Удалить эту точку из маршрута?')) return
    dispatch({ type: 'delete-point', pointId })
  }

  const save = async () => {
    setSubmitAttempted(true)
    setSaveError(null)
    const current = draftRef.current
    const errors = raidTemplateDraftErrors(current)
    if (errors.length > 0) return
    if (!navigator.onLine) {
      setSaveError('Для сохранения маршрута в Кабанде нужно подключение к интернету. Локальный черновик не пропадёт.')
      return
    }
    setSaveState('saving')
    try {
      await createRaidTemplate(kabanda.id, {
        scope: current.scope,
        title: current.title.trim(),
        coverImage: current.coverImage!,
        points: current.points.map(({ name, address, comment, latitude, longitude }) => ({
          name: name.trim(),
          address: address.trim(),
          comment: comment.trim(),
          latitude,
          longitude,
        })),
      }, current.idempotencyKey)
      clearRaidTemplateDraft(identityId, kabanda.id)
      window.location.assign(`${appPath('app')}?kabanda=${encodeURIComponent(kabanda.id)}&tab=raids`)
    } catch (error) {
      setSaveState('error')
      setSaveError(error instanceof ApiError ? error.message : 'Маршрут не сохранился. Повтор использует тот же ключ и не создаст дубль.')
    }
  }

  return <EditorShell kabandaId={kabanda.id}>
    <header className="rt-editor__heading">
      <div>
        <p>{kabanda.name}</p>
        <h1>Новый маршрут</h1>
      </div>
      <span className={`rt-editor__local-state rt-editor__local-state--${localState}`} role="status">
        {localState === 'saving' ? 'Сохраняем черновик…' : localState === 'saved' ? 'Черновик на устройстве' : 'Черновик только в памяти'}
      </span>
    </header>

    <section className="rt-editor__basics" aria-labelledby="rt-basics-heading">
      <div className="rt-editor__section-head">
        <span>1</span><div><h2 id="rt-basics-heading">Название и обложка</h2><p>Их увидят участники в каталоге маршрутов.</p></div>
      </div>
      <label htmlFor="rt-template-title">Название маршрута</label>
      <input
        autoCapitalize="sentences"
        id="rt-template-title"
        maxLength={120}
        onChange={(event) => dispatch({ type: 'set-title', title: event.target.value })}
        placeholder="Например, Набережная и центр"
        required
        value={draft.title}
      />
      <label className={`rt-cover${draft.coverImage ? ' rt-cover--ready' : ''}`}>
        <input accept="image/jpeg,image/png,image/webp" aria-label={draft.coverImage ? 'Заменить обложку маршрута' : 'Добавить обложку маршрута'} disabled={coverState === 'processing'} onChange={(event) => void prepareCover(event)} type="file" />
        {draft.coverImage ? <img alt="Предпросмотр обложки маршрута" src={draft.coverImage} /> : <span aria-hidden="true" className="rt-cover__icon">＋</span>}
        <span className="rt-cover__copy"><strong>{coverState === 'processing' ? 'Готовим изображение…' : draft.coverImage ? 'Заменить обложку' : 'Добавить обложку'}</strong><small>JPEG, PNG или WebP · до 12 МБ</small></span>
      </label>
      {coverError && <p className="rt-editor__error" role="alert">{coverError}</p>}
      <RaidTemplateScopeControl
        kabandaName={kabanda.name}
        onChange={(scope) => dispatch({ type: 'set-scope', scope })}
        scope={draft.scope}
      />
    </section>

    <section className="rt-editor__route" aria-labelledby="rt-route-heading">
      <div className="rt-editor__section-head">
        <span>2</span><div><h2 id="rt-route-heading">Точки маршрута</h2><p>Добавьте от 2 до 10 мест в нужном порядке.</p></div>
      </div>
      <RaidTemplateEditorMap
        canAddPoint={draft.points.length < RAID_TEMPLATE_MAX_POINTS}
        onAddPoint={addPoint}
        onRouteState={handleRouteState}
        onSelectPoint={(pointId) => dispatch({ type: 'select-point', pointId })}
        pointSheetHeight={pointSheetHeight}
        points={draft.points}
        selectedPointId={draft.selectedPointId}
      />
      <div className="rt-route-summary" aria-live="polite">
        <span><strong>{draft.points.length}</strong><small>{pointCountLabel(draft.points.length)}</small></span>
        <span><strong>{summary.distance}</strong><small>{summary.label}</small></span>
      </div>
      <RaidTemplatePointList
        onDelete={deletePoint}
        onMove={(pointId, direction) => dispatch({ type: 'move-point', pointId, direction })}
        onReorder={(activeId, overId) => dispatch({ type: 'reorder-point', activeId, overId })}
        onSelect={(pointId) => dispatch({ type: 'select-point', pointId })}
        points={draft.points}
        selectedPointId={draft.selectedPointId}
      />
    </section>

    {submitAttempted && validationErrors.length > 0 && <div className="rt-editor__validation" role="alert">
      <strong>Маршрут пока не готов</strong>
      <ul>{validationErrors.map((error) => <li key={error}>{error}</li>)}</ul>
    </div>}
    {!online && <p className="rt-editor__offline" role="status">Нет сети. Можно продолжать редактирование — черновик останется на устройстве.</p>}
    {saveError && <p className="rt-editor__error rt-editor__save-error" role="alert">{saveError}</p>}
    <button className="rt-editor__save" disabled={saveState === 'saving' || coverState === 'processing'} onClick={() => void save()} type="button">
      {saveState === 'saving' ? 'Сохраняем маршрут…' : 'Сохранить маршрут'}
    </button>

    {selectedPoint && <RaidTemplatePointSheet
      onClose={() => dispatch({ type: 'select-point', pointId: null })}
      onConfirm={() => {
        dispatch({ type: 'confirm-point-labels', pointId: selectedPoint.clientId })
        dispatch({ type: 'select-point', pointId: null })
      }}
      onDelete={() => deletePoint(selectedPoint.clientId)}
      onRetryGeocode={() => void requestGeocode(selectedPoint)}
      onHeightChange={setPointSheetHeight}
      onUpdate={(patch) => dispatch({ type: 'update-point', pointId: selectedPoint.clientId, patch })}
      point={selectedPoint}
      pointNumber={selectedPointNumber}
    />}
  </EditorShell>
}

export function RaidTemplateScopeControl({
  kabandaName,
  onChange,
  scope,
}: {
  kabandaName: string
  onChange: (scope: RaidTemplateDraft['scope']) => void
  scope: RaidTemplateDraft['scope']
}) {
  return <fieldset className="rt-visibility">
    <legend>Доступ к маршруту</legend>
    <div className="rt-visibility__options">
      <label>
        <input
          checked={scope === 'kabanda'}
          name="raid-template-scope"
          onChange={() => onChange('kabanda')}
          type="radio"
        />
        <span><strong>Только для своих</strong><small>{kabandaName}</small></span>
      </label>
      <label>
        <input
          checked={scope === 'all_authenticated'}
          name="raid-template-scope"
          onChange={() => onChange('all_authenticated')}
          type="radio"
        />
        <span><strong>Для всех</strong><small>Все пользователи приложения</small></span>
      </label>
    </div>
    <p>{scope === 'all_authenticated'
      ? 'Обложку, комментарии и координаты увидят все участники приложения.'
      : 'Маршрут увидят только участники вашей Кабанды.'}</p>
  </fieldset>
}

function EditorShell({ kabandaId, children }: { kabandaId: string; children: ReactNode }) {
  return <main className="rt-editor-shell">
    <nav className="rt-editor-nav" aria-label="Навигация конструктора">
      <a href={`${appPath('app')}?kabanda=${encodeURIComponent(kabandaId)}&tab=raids`} aria-label="Вернуться к рейдам">← <span>Рейды</span></a>
      <a className="rt-editor-nav__brand" href={appPath('app')} aria-label="КАБАНДА — на главную"><img alt="" src={appPath('brand/kabanda-logo-reference.png')} /><strong>КАБАНДА</strong></a>
    </nav>
    {children}
  </main>
}

function EditorError({ title, detail }: { title: string; detail: string }) {
  return <section className="rt-editor-state"><h1>{title}</h1><p>{detail}</p><a href={appPath('app')}>На главную</a></section>
}

function estimateSummary(estimate: DraftRouteEstimate): { distance: string; label: string } {
  if (estimate.status === 'idle') return { distance: '—', label: 'добавьте 2 точки' }
  if (estimate.status === 'calculating') return {
    distance: estimate.fallbackDistanceMeters === null ? '…' : `≈ ${formatPlanDistance(estimate.fallbackDistanceMeters)}`,
    label: 'строим веломаршрут',
  }
  return {
    distance: `≈ ${formatPlanDistance(estimate.distanceMeters)}`,
    label: estimate.status === 'ready' ? 'веломаршрут Яндекса' : 'по прямым отрезкам',
  }
}

function pointCountLabel(count: number): string {
  if (count === 1) return 'точка'
  if (count >= 2 && count <= 4) return 'точки'
  return 'точек'
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}
