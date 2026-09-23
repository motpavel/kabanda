import '../../app/fonts.css'
import { AlphaDiagnosticsConsent } from '../../app/AlphaDiagnosticsConsent'
import { RiderLoader } from '../../app/RiderLoader'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import type { User } from '@kabanda/contracts'
import { ApiError } from '../../lib/http'
import { useSheetViewport } from '../../components/sheets/useSheetViewport'
import { PointInfoSheet } from '../checkins/PointInfoSheet'
import { PointVisitHistory } from '../checkins/PointVisitHistory'
import { appPath, appUrl } from '../../lib/paths'
import { AppTabBar, TabIcon } from '../../app/AppTabBar'
import { navigateApp } from '../../app/transitions'
import { replaceAppLocation } from '../../app/navigation-history'
import { useScreenScroll } from '../../app/screen-scroll'
import { RetainedScreen } from '../../app/RetainedScreen'
import { clearPrivateImageCache } from '../../lib/CachedImage'
import { useHomeSession } from '../auth/useHomeSession'
import { SessionUnavailable } from '../auth/SessionUnavailable'
import { signInFailureMessage } from '../auth/session-policy'
import {
  appSectionSearch,
  parseAppSection,
  resolveSelectedKabandaId,
  type AppSection,
} from '../../app/navigation'
import { loginWithPassword, logout } from '../auth/api'
import { InstallGuidance } from '../install/InstallGuidance'
import { getIdentityLocalInventory, type IdentityLocalInventory } from '../offline/inventory'
import {
  createKabanda,
  createInvite,
  listKabandas,
  listMembers,
  listPoints,
  leaveKabanda,
  removeMember,
  transferLeadership,
  updateKabanda,
} from './api'
import { readPointProjection, savePointProjection } from './cache'
import { choosePointPresentation, detectWebgl } from './map-state'
import { MapViewportMemory, type MapView } from './map-viewport'
import { MapCamera } from './map-camera'
import { MapMarkers } from './map-markers'
import { MapBackgroundTap, isMapMarkerHit } from './map-background-tap'
import { attachYandexTileCache } from './tiles/yandex-tile-cache'
import { useNearbyPointHistory } from '../results/useNearbyPointHistory'
import { pointVisitProgress, visitStateLabel, type VisitState } from './point-progress'
import { usePointProgress } from '../results/exploration-resources'
import { IZHEVSK_KB_STORES } from './izhevsk-kb-stores'
import { loadYandexMaps, scheduleYandexMapsWarmup, type YandexMap, type YandexMapsRuntime, type YandexPlacemark } from './yandex-maps'
import { useKabandaMotion } from './useKabandaMotion'
import { HomeDashboard } from '../home/HomeDashboard'
import { ProductionRaidsHub } from '../raids/ProductionRaidsHub'
import { useKabandaProgress } from '../raids/resources'
import type {
  KabandaMember,
  KabandaPoint,
  KabandaSummary,
  PointPresentation,
  ProviderState,
} from './types'
import './kabandas.css'
import './point-progress.css'

type MapPointCategory = 'stores' | 'attractions'
type MapPoint = KabandaPoint & {
  category: MapPointCategory
  address?: string
  hours?: string
  visitState?: VisitState
  historyPointId?: string | null
}

const STORE_MAP_POINTS: readonly MapPoint[] = IZHEVSK_KB_STORES.map((store) => ({
  id: store.id,
  stableId: store.id,
  name: `Красное&Белое №${store.shopNumber}`,
  latitude: store.latitude,
  longitude: store.longitude,
  verificationStatus: 'source_checked',
  visitedByMe: false,
  visitedByTeam: false,
  visitedByMeCount: 0,
  visitedByTeamCount: 0,
  visitState: 'unknown',
  category: 'stores',
  address: store.address,
  hours: store.hours,
}))

export function KabandasPage({ active = true }: { active?: boolean }) {
  const { session, checking, refresh, signedIn, signedOut } = useHomeSession(active)
  if (session.state === 'loading') {
    return <main className="kb-shell kb-center"><RiderLoader label="Загружаем Кабанду" /></main>
  }
  if (session.state === 'unavailable') return <main className="kb-shell kb-center"><SessionUnavailable message={session.message} checking={checking} onRetry={() => void refresh()} /></main>
  if (session.state === 'anonymous') return <SignInPanel onSignedIn={signedIn} />
  return <>
    {active && session.warning && <aside className="kb-notice" role="status">{session.warning} <button type="button" disabled={checking} onClick={() => void refresh()}>{checking ? 'Проверяем…' : 'Повторить проверку'}</button></aside>}
    <AuthenticatedKabandas key={session.user.id} active={active} user={session.user} onLoggedOut={signedOut} />
  </>
}

function SignInPanel({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (state === 'sending') return
    setState('sending')
    setErrorMessage(null)
    try {
      onSignedIn(await loginWithPassword(username, password))
    } catch (error) {
      setErrorMessage(signInFailureMessage(error))
      setState('error')
    }
  }

  return (
    <main className="kb-shell kb-center kb-auth-shell">
      <section className="kb-auth-layout kb-login-layout">
        <div className="kb-login-visual">
          <img
            src={appPath('brand/kabanda-login-riders.jpg')}
            alt=""
            width="907"
            height="1734"
            decoding="async"
            fetchPriority="high"
          />
          <p>Город — ваш общий маршрут.</p>
        </div>
        <div className="kb-auth-form">
          <div className="kb-auth-heading">
            <span className="kb-inline-mark" aria-hidden="true"><img src={appPath('brand/kabanda-logo-reference.png')} alt="" /></span>
            <h2>Войти в Кабанду</h2>
          </div>
          <form onSubmit={submit}>
            <label htmlFor="kb-username">Логин</label>
            <input id="kb-username" autoComplete="username" required minLength={3} maxLength={32} value={username} onChange={(event) => setUsername(event.target.value)} />
            <label htmlFor="kb-password">Пароль</label>
            <input id="kb-password" type="password" autoComplete="current-password" required minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} />
            <button className="kb-primary" type="submit" disabled={state === 'sending'}>
              {state === 'sending' ? 'Входим…' : 'Войти'}
            </button>
          </form>
          {state === 'error' && <p className="kb-error" role="alert">{errorMessage}</p>}
        </div>
      </section>
    </main>
  )
}

function AuthenticatedKabandas({ user, onLoggedOut, active }: { user: User; onLoggedOut: () => void; active: boolean }) {
  const [kabandas, setKabandas] = useState<KabandaSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [listRetry, setListRetry] = useState(0)
  const [showCreate, setShowCreate] = useState(false)
  const [routeSearch, setRouteSearch] = useState(window.location.search)
  const [inventory, setInventory] = useState<IdentityLocalInventory | null>(null)
  const [accountState, setAccountState] = useState<'idle' | 'loading' | 'leaving' | 'error'>('idle')
  const activeSection = parseAppSection(routeSearch)
  const requestedKabandaId = new URLSearchParams(routeSearch).get('kabanda')
  useScreenScroll(JSON.stringify([user.id, selectedId, activeSection, showCreate]), active)

  useEffect(() => {
    const restoreRoute = () => setRouteSearch(window.location.search)
    window.addEventListener('popstate', restoreRoute)
    return () => window.removeEventListener('popstate', restoreRoute)
  }, [])

  useEffect(() => {
    if (!active) return
    let subscribed = true
    listKabandas()
      .then((items) => {
        if (!subscribed) return
        setKabandas(items)
        setError(null)
        setSelectedId((current) => resolveSelectedKabandaId(items.map(({ id }) => id), requestedKabandaId, current))
      })
      .catch((reason) => {
        if (!subscribed) return
        if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) {
          clearPrivateImageCache()
          setKabandas([])
          setSelectedId(null)
        }
        setError('Не удалось загрузить Кабанды.')
      })
      .finally(() => subscribed && setLoading(false))
    return () => {
      subscribed = false
    }
  }, [requestedKabandaId, active, listRetry])

  const selected = kabandas.find(({ id }) => id === selectedId) ?? null
  const addKabanda = (kabanda: KabandaSummary) => {
    setKabandas((items) => [kabanda, ...items.filter(({ id }) => id !== kabanda.id)])
    setSelectedId(kabanda.id)
    setShowCreate(false)
  }
  const removeKabandaLocally = (kabandaId: string) => {
    clearPrivateImageCache()
    setKabandas((items) => {
      const next = items.filter(({ id }) => id !== kabandaId)
      setSelectedId(next[0]?.id ?? null)
      return next
    })
  }
  const updateKabandaLocally = (updated: KabandaSummary) => {
    setKabandas((items) => items.map((item) => item.id === updated.id ? updated : item))
  }
  const selectSection = (section: AppSection) => {
    const search = appSectionSearch(window.location.search, section, selectedId)
    const order = ['home', 'map', 'raids', 'kabanda']
    navigateApp(`${appPath('app')}${search}`, order.indexOf(section) < order.indexOf(activeSection) ? 'back' : 'forward')
  }
  const selectKabanda = (kabandaId: string) => {
    const search = appSectionSearch(window.location.search, activeSection, kabandaId)
    if (!replaceAppLocation(`${appPath('app')}${search}`)) return
    setSelectedId(kabandaId)
    setRouteSearch(search)
  }

  useEffect(() => {
    if (!active || activeSection !== 'kabanda') return
    setAccountState('loading')
    void getIdentityLocalInventory(user.id)
      .then((value) => {
        setInventory(value)
        setAccountState('idle')
      })
      .catch(() => setAccountState('error'))
  }, [active, activeSection, user.id])
  const leaveAccount = async () => {
    if (accountState === 'leaving') return
    setAccountState('leaving')
    try {
      const latestInventory = await getIdentityLocalInventory(user.id)
      if (!latestInventory) throw new Error('Active identity changed before logout')
      setInventory(latestInventory)
      if (latestInventory.activeRecordings > 0) {
        setAccountState('idle')
        return
      }
      await logout()
      onLoggedOut()
    } catch {
      setAccountState('error')
    }
  }

  if (loading && !selected && !error) return <main className="kb-shell kb-center"><RiderLoader label="Загружаем Кабанду" /></main>

  return (
    <main className={`kb-shell kb-shell--tabs${activeSection === 'map' ? ' kb-shell--map' : ''}${activeSection !== 'map' ? ' kb-shell--team' : ''}${activeSection === 'home' ? ' kb-shell--home' : ''}`}>
      <header className="kb-topbar">
        <Brand />
        <button className="kb-identity kb-account-trigger" type="button" aria-current={activeSection === 'kabanda' ? 'page' : undefined} onClick={() => selectSection('kabanda')} aria-label={`Открыть раздел «Кабанда». Аккаунт: ${user.displayName ?? user.username ?? user.email ?? 'Участник'}`}>
          <span>{(user.displayName ?? user.username ?? user.email ?? 'У').slice(0, 1).toUpperCase()}</span>
          {activeSection !== 'kabanda' && activeSection !== 'home' && <div><strong>{user.displayName ?? user.username ?? 'Участник'}</strong><small>{user.username ? `@${user.username}` : user.email}</small></div>}
        </button>
      </header>

      {(activeSection === 'map' || (activeSection === 'home' && !selected)) && <section className="kb-heading-row">
        <div><h1>{sectionHeading(activeSection).title}</h1><p>{sectionHeading(activeSection).description}</p></div>
      </section>}

      {activeSection === 'kabanda' && user.identityKind === 'verified' && showCreate && <CreateKabandaForm onCreated={addKabanda} onCancel={() => setShowCreate(false)} />}
      {error && <p className="kb-error" role="alert">{error} <button type="button" disabled={loading} onClick={() => { setLoading(true); setListRetry(value => value + 1) }}>Повторить</button></p>}
      {loading ? <p className="kb-muted" aria-busy="true">Загружаем команды…</p> : null}

      {!loading && !error && kabandas.length === 0 && !showCreate && (
        <section className="kb-card kb-empty"><h2>Пока без Кабанды</h2><p>Создайте первую команду или откройте приглашение, которое вам прислали.</p>{user.identityKind === 'verified' ? <button className="kb-primary" type="button" onClick={() => { selectSection('kabanda'); setShowCreate(true) }}>Создать Кабанду</button> : null}</section>
      )}

      {selected && !showCreate && <KabandaWorkspace
        key={selected.id}
        user={user}
        kabanda={selected}
        section={activeSection}
        active={active}
        inventory={inventory}
        accountState={accountState}
        onLeft={() => removeKabandaLocally(selected.id)}
        onKabandaUpdated={updateKabandaLocally}
        onSwitchAccount={() => void leaveAccount()}
      />}
      {activeSection === 'home' && <div className="kb-home-install"><InstallGuidance /></div>}
      <AppTabBar active={activeSection} kabandaId={selectedId} onSelect={selectSection} />
    </main>
  )
}

function sectionHeading(section: AppSection): { title: string; description: string } {
  return {
    home: { title: 'Главная', description: 'Что важно вашей Кабанде прямо сейчас.' },
    map: { title: 'Карта', description: 'Точки общего маршрута и ваш прогресс.' },
    raids: { title: 'Рейды', description: 'Ближайшие поездки и завершённая история.' },
    kabanda: { title: 'Моя Кабанда', description: 'Команда, приглашения и ваш аккаунт.' },
  }[section]
}

function CreateKabandaForm({ onCreated, onCancel }: { onCreated: (kabanda: KabandaSummary) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState('🐗')
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle')
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = name.trim()
    if (!value || state === 'saving') return
    setState('saving')
    try {
      onCreated(await createKabanda(value, avatar, idempotencyKey))
    } catch {
      setState('error')
    }
  }
  return (
    <form className="kb-card kb-create" onSubmit={submit}>
      <div><label htmlFor="kabanda-name">Название Кабанды</label><input id="kabanda-name" required minLength={2} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Например, Самарские кабаны" /></div>
      <fieldset className="kb-avatar-picker"><legend>Аватар</legend>{['🐗', '🚲', '🌲', '⚡', '🌙', '🔥'].map((option) => <button key={option} type="button" aria-pressed={avatar === option} aria-label={`Аватар ${option}`} onClick={() => setAvatar(option)}>{option}</button>)}</fieldset>
      <div className="kb-actions"><button className="kb-primary" type="submit" disabled={state === 'saving'}>{state === 'saving' ? 'Создаём…' : 'Создать'}</button><button type="button" onClick={onCancel}>Отмена</button></div>
      {state === 'error' && <p className="kb-error" role="alert">Не удалось создать Кабанду.</p>}
    </form>
  )
}

function KabandaWorkspace({
  user,
  kabanda,
  section,
  active,
  inventory,
  accountState,
  onLeft,
  onKabandaUpdated,
  onSwitchAccount,
}: {
  user: User
  kabanda: KabandaSummary
  section: AppSection
  active: boolean
  inventory: IdentityLocalInventory | null
  accountState: 'idle' | 'loading' | 'leaving' | 'error'
  onLeft: () => void
  onKabandaUpdated: (kabanda: KabandaSummary) => void
  onSwitchAccount: () => void
}) {
  const workspaceRef = useRef<HTMLElement>(null)
  const [members, setMembers] = useState<KabandaMember[]>([])
  const [points, setPoints] = useState<KabandaPoint[]>([])
  const [loadedCollectionId, setLoadedCollectionId] = useState<string | null>(null)
  const [mapViewport] = useState(() => new MapViewportMemory())
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null)
  const [pointCategory, setPointCategory] = useState<MapPointCategory>('stores')
  const [requestedView, setRequestedView] = useState<PointPresentation>('map')
  const [providerState, setProviderState] = useState<ProviderState>('checking')
  const [attractionState, setAttractionState] = useState<ProviderState>('checking')
  const [staleAt, setStaleAt] = useState<string | null>(null)
  const [pointMessage, setPointMessage] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [membershipAction, setMembershipAction] = useState<string | null>(null)
  const [teamMenuOpen, setTeamMenuOpen] = useState(false)
  const [adminDialog, setAdminDialog] = useState<'rename' | 'members' | 'leadership' | null>(null)
  const adminSheetRef = useRef<HTMLElement>(null)
  useSheetViewport(adminSheetRef, { open: adminDialog !== null })
  useEffect(() => {
    if (adminDialog === 'rename') adminSheetRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
  }, [adminDialog])
  const [renameDraft, setRenameDraft] = useState(kabanda.name)
  const [teamAction, setTeamAction] = useState<'rename' | 'cover' | 'leadership' | null>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)
  const webglAvailable = useMemo(detectWebgl, [])
  const pointsKnown = loadedCollectionId !== null && loadedCollectionId === kabanda.pointsCollectionId
  // Attractions already expose canonical cumulative visits through /api/points.
  // Stores keep their static geometry, but never derive awards from that catalog.
  const storeProgress = usePointProgress(user.id, kabanda.id, 'stores', null, active && section === 'map' && pointCategory === 'stores')
  const storePoints = useMemo<MapPoint[]>(() => STORE_MAP_POINTS.map(point => {
    const visit = pointVisitProgress(storeProgress.data, point)
    return { ...point, visitState: visit.visitState, historyPointId: visit.historyPointId,
      visitedByMe: visit.visitState === 'personal', visitedByTeam: visit.visitState === 'personal' || visit.visitState === 'team',
      visitedByMeCount: visit.personalCount ?? 0, visitedByTeamCount: visit.teamCount ?? 0 }
  }), [storeProgress.data])
  const attractionPoints = useMemo<MapPoint[]>(() => pointsKnown ? points.map((point) => ({ ...point, category: 'attractions' })) : [], [points, pointsKnown])
  const visiblePoints = pointCategory === 'stores' ? storePoints : attractionPoints
  const activeProviderState = pointCategory === 'attractions'
    ? attractionState === 'failed' ? 'failed' : attractionState === 'checking' ? 'checking' : providerState
    : providerState
  const presentation = choosePointPresentation(requestedView, activeProviderState, webglAvailable)
  const mapActive = active && section === 'map'
  useEffect(() => {
    if (!active || section !== 'home') return
    return scheduleYandexMapsWarmup(import.meta.env.VITE_YANDEX_MAPS_API_KEY?.trim() ?? '')
  }, [active, section])
  useEffect(() => { if (!mapActive) setSelectedPointId(null) }, [mapActive])
  useKabandaMotion(workspaceRef)

  const needsMembers = active && (section === 'home' || section === 'kabanda')
  const { data: progress } = useKabandaProgress(user.id, kabanda.id, needsMembers)
  useEffect(() => {
    if (!needsMembers) return
    let subscribed = true
    void listMembers(kabanda.id)
      .then((value) => { if (subscribed) setMembers(value) })
      .catch(() => { if (subscribed) setMessage('Участники временно недоступны.') })
    return () => { subscribed = false }
  }, [kabanda.id, needsMembers])

  const needsPoints = active && (section === 'kabanda' || (section === 'map' && pointCategory === 'attractions'))
  useEffect(() => {
    if (!needsPoints) return
    let subscribed = true
    let receivedFresh = false
    const collectionId = kabanda.pointsCollectionId
    if (!collectionId) {
      setLoadedCollectionId(null)
      setAttractionState('failed')
      setPointMessage('Вожак ещё не загрузил набор достопримечательностей.')
      return
    }
    void readPointProjection(user.id, kabanda.id, collectionId).then((cached) => {
      if (!subscribed || receivedFresh || !cached) return
      setPoints(cached.points)
      setLoadedCollectionId(collectionId)
      setAttractionState('ready')
      setStaleAt(cached.savedAt)
    }).catch(() => undefined)
    void listPoints(collectionId, [53.06, 56.74, 53.31, 56.94], 100)
      .then(async ({ points: fresh }) => {
        if (!subscribed) return
        receivedFresh = true
        setPoints(fresh)
        setLoadedCollectionId(collectionId)
        setAttractionState('ready')
        setPointMessage(null)
        setStaleAt(null)
        // Local quota failure must not replace a successful response with old points.
        await savePointProjection(user.id, kabanda.id, collectionId, fresh).catch(() => undefined)
      })
      .catch(async (reason) => {
        if (!subscribed) return
        if (reason instanceof ApiError && reason.status < 500) {
          receivedFresh = true
          setPoints([])
          setLoadedCollectionId(null)
          setAttractionState('failed')
          setPointMessage('Доступ к достопримечательностям недоступен.')
          return
        }
        const cached = await readPointProjection(user.id, kabanda.id, collectionId).catch(() => null)
        if (!subscribed) return
        setAttractionState(cached ? 'ready' : 'failed')
        if (cached) {
          setPoints(cached.points)
          setLoadedCollectionId(collectionId)
          setStaleAt(cached.savedAt)
        } else setPointMessage('Достопримечательности недоступны без сети и ещё не сохранены на этом устройстве.')
      })
    return () => { subscribed = false }
  }, [kabanda.id, kabanda.pointsCollectionId, user.id, needsPoints])

  const selectedPoint = visiblePoints.find(({ id }) => id === selectedPointId) ?? null
  const selectedHistoryId = selectedPoint?.category === 'attractions' ? selectedPoint.id : selectedPoint?.historyPointId
  const rename = async (event: FormEvent) => {
    event.preventDefault()
    const name = renameDraft.trim()
    if (!name || teamAction) return
    setTeamAction('rename')
    try {
      const updated = await updateKabanda(kabanda.id, { name })
      onKabandaUpdated(updated)
      setAdminDialog(null)
      setMessage('Название Кабанды обновлено.')
    } catch {
      setMessage('Не удалось переименовать Кабанду. Повторите позже.')
    } finally {
      setTeamAction(null)
    }
  }
  const chooseCover = () => {
    setTeamMenuOpen(false)
    coverInputRef.current?.click()
  }
  const changeCover = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file || teamAction) return
    setTeamAction('cover')
    try {
      const coverImage = await prepareKabandaCover(file)
      const updated = await updateKabanda(kabanda.id, { coverImage })
      onKabandaUpdated(updated)
      setMessage('Заставка Кабанды обновлена.')
    } catch {
      setMessage('Не удалось сменить заставку. Выберите JPG, PNG или WebP до 12 МБ.')
    } finally {
      event.target.value = ''
      setTeamAction(null)
    }
  }
  const remove = async (member: KabandaMember) => {
    if (!window.confirm(`Удалить ${member.displayName} из Кабанды?`)) return
    setMembershipAction(member.id)
    try {
      await removeMember(kabanda.id, member.id)
      setMembers((items) => items.filter(({ id }) => id !== member.id))
    } catch {
      setMessage('Не удалось удалить участника. Обновите состав и повторите.')
    } finally {
      setMembershipAction(null)
    }
  }
  const handOverLeadership = async (member: KabandaMember) => {
    if (!window.confirm(`Передать права вожака участнику ${member.displayName}? После этого управлять Кабандой сможет он.`)) return
    setTeamAction('leadership')
    try {
      const updated = await transferLeadership(kabanda.id, member.id)
      onKabandaUpdated(updated)
      setMembers((items) => items.map((item) => item.id === user.id
        ? { ...item, role: 'member' }
        : item.id === member.id ? { ...item, role: 'owner' } : item))
      setAdminDialog(null)
      setMessage(`Права вожака переданы участнику ${member.displayName}.`)
    } catch {
      setMessage('Не удалось передать права вожака. Обновите состав и повторите.')
    } finally {
      setTeamAction(null)
    }
  }
  const leave = async () => {
    if (!window.confirm(`Выйти из «${kabanda.name}»?`)) return
    setMembershipAction('me')
    try {
      await leaveKabanda(kabanda.id)
      onLeft()
    } catch {
      setMessage('Не удалось выйти из Кабанды. Повторите после восстановления связи.')
      setMembershipAction(null)
    }
  }

  const notices = <>
    {section === 'map' && pointCategory === 'attractions' && staleAt && <p className="kb-stale" role="status">Сохранённые данные от {new Date(staleAt).toLocaleString('ru-RU')}.</p>}
    {section === 'map' && pointCategory === 'attractions' && pointMessage && <p className="kb-notice" role="status">{pointMessage}</p>}
    {section === 'map' && pointCategory === 'stores' && storeProgress.status === 'loading' && <p className="kb-notice" role="status">Проверяем посещения. Точки уже доступны на карте.</p>}
    {section === 'map' && pointCategory === 'stores' && storeProgress.status === 'stale' && !storeProgress.message && <p className="kb-stale" role="status">Сохранённые посещения. Уточняем данные.</p>}
    {section === 'map' && pointCategory === 'stores' && storeProgress.message && <p className="kb-notice" role="status">{storeProgress.message} <button type="button" onClick={() => void storeProgress.refresh()}>Обновить посещения</button></p>}
    {message && <p className="kb-notice" role="status">{message}</p>}
  </>

  const homePanel = (
      <HomeDashboard active={active && section === 'home'} identityId={user.id} kabanda={kabanda} members={members} progress={progress} notices={notices} />
    )

  const mapPanel = (
      <section className="kb-map-screen" ref={mapActive ? workspaceRef : null} aria-label="Точки маршрута">
        <div className="kb-map-stage">
          <div className="kb-map-controls">
            <label className="kb-map-category">
              <span className="kb-visually-hidden">Категория точек</span>
              <select value={pointCategory} onChange={(event) => {
                setPointCategory(event.target.value as MapPointCategory)
                setSelectedPointId(null)
              }}>
                <option value="stores">Красное&amp;Белое</option>
                <option value="attractions">Достопримечательности</option>
              </select>
            </label>
            <div className="kb-view-switch kb-map-view-switch" aria-label="Вид точек">
              <button type="button" aria-pressed={presentation === 'map'} disabled={!webglAvailable || activeProviderState === 'failed'} onClick={() => setRequestedView('map')}>Карта</button>
              <button type="button" aria-pressed={presentation === 'list'} onClick={() => setRequestedView('list')}>Список</button>
            </div>
          </div>
          <div className="kb-map-notices">{notices}</div>
          {pointCategory === 'attractions' && attractionState === 'checking' ? <p className="kb-map-loading" aria-busy="true">Получаем достопримечательности…</p> : null}
          <RetainedScreen active={presentation === 'map'}><PointsMap visible={mapActive && presentation === 'map'} identityId={user.id} kabandaId={kabanda.id}
            historyPrefetchEnabled={pointCategory === 'stores' ? storeProgress.status === 'ready' : pointsKnown && !staleAt && !pointMessage}
            memory={mapViewport} points={visiblePoints} selectedId={selectedPointId} onSelect={setSelectedPointId} setProviderState={setProviderState} /></RetainedScreen>
          {(presentation === 'list' || visiblePoints.length === 0) && (
            <div className="kb-map-list-panel">
              {pointCategory === 'attractions' && !pointsKnown
                ? <p className="kb-points-pending" role="status">{attractionState === 'checking' ? 'Получаем точки…' : 'Точки пока недоступны.'}</p>
                : <PointList points={visiblePoints} selectedId={selectedPointId} onSelect={setSelectedPointId} />}
              {activeProviderState === 'failed' && visiblePoints.length > 0 && <p className="kb-muted">Карта сейчас недоступна. Точки остаются доступны списком.</p>}
            </div>
          )}
          <PointInfoSheet open={mapActive && Boolean(selectedPoint)} onClose={() => setSelectedPointId(null)} title={selectedPoint?.name ?? ''}>
            {selectedPoint?.hours && <p className="kb-point-hours"><span>Часы работы</span><strong>{selectedPoint.hours}</strong></p>}
            {selectedPoint && mapVisitState(selectedPoint) !== 'unvisited' && <p className="kb-point-visit-state" data-visit-state={mapVisitState(selectedPoint)}>{visitStateLabel(mapVisitState(selectedPoint))}</p>}
            {mapActive && selectedHistoryId && <PointVisitHistory compactLoading key={`${user.id}:${kabanda.id}:${selectedHistoryId}`} identityId={user.id} kabandaId={kabanda.id} pointId={selectedHistoryId} onOpenRaid={() => undefined} />}
          </PointInfoSheet>
        </div>
      </section>
    )

  const raidsPanel = (
      <section className="kb-workspace kb-workspace--single" ref={section === 'raids' ? workspaceRef : null}>
        <div className="kb-workspace-main kb-workspace-main--wide">
          {notices}
          <ProductionRaidsHub identityId={user.id} kabanda={kabanda} active={active && section === 'raids'} />
        </div>
      </section>
    )

  // The same frozen-result totals as Home, across every point category. Counting
  // the currently loaded attraction slice would hide all store/custom progress.
  const personalPoints = progress?.personal.uniquePoints ?? null
  const teamPoints = progress?.team.uniquePoints ?? null
  const completedRaids = progress?.team.completedRaids ?? null
  const memberCount = members.length || kabanda.memberCount
  const roleLabel = kabanda.role === 'owner' ? 'Вы вожак' : 'Вы участник'

  const teamPanel = (
    <section className="kb-team-page" ref={section === 'kabanda' ? workspaceRef : null}>
      <div className="kb-team-page-inner">
        {notices}

        <article className="kb-team-hero">
          <div className="kb-team-cover">
            <img
              src={kabanda.coverImage ?? appPath('brand/kabanda-team-cover.jpg')}
              alt="Кабаны на велосипедах едут вместе по городу"
              width="1792"
              height="896"
              decoding="async"
            />
            {kabanda.role === 'owner' && (
              <div className="kb-team-cover-menu">
                <button className="kb-team-menu-trigger" type="button" aria-label="Управление Кабандой" aria-expanded={teamMenuOpen} onClick={() => setTeamMenuOpen((value) => !value)}>
                  <span className="kb-team-menu-dots" aria-hidden="true"><i /><i /><i /></span>
                </button>
                {teamMenuOpen && (
                  <div className="kb-team-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => { setRenameDraft(kabanda.name); setAdminDialog('rename'); setTeamMenuOpen(false) }}>Переименовать Кабанду</button>
                    <button type="button" role="menuitem" disabled={teamAction === 'cover'} onClick={chooseCover}>{teamAction === 'cover' ? 'Обрабатываем заставку…' : 'Сменить заставку'}</button>
                    <button type="button" role="menuitem" onClick={() => { setAdminDialog('leadership'); setTeamMenuOpen(false) }}>Передать права вожака</button>
                    <button className="kb-team-menu-danger" type="button" role="menuitem" onClick={() => { setAdminDialog('members'); setTeamMenuOpen(false) }}>Удалить участников</button>
                  </div>
                )}
                <input ref={coverInputRef} className="kb-visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void changeCover(event)} />
              </div>
            )}
          </div>
          <div className="kb-team-identity-row">
            <div>
              <h1>{kabanda.name}</h1>
              <div className="kb-team-meta">
                <span className="kb-role-pill">{roleLabel}</span>
                <span className="kb-member-count"><TeamScreenIcon name="members" />{memberCount} {pluralizeMembers(memberCount)}</span>
              </div>
            </div>
          </div>
          <div className="kb-team-stats" aria-label="Статистика Кабанды" title="Итоги завершённых рейдов, все категории точек">
            <TeamMetric icon="point" value={personalPoints} label="точек лично" />
            <TeamMetric icon="members" value={teamPoints} label="точек кабанды" />
            <TeamMetric icon="bike" value={completedRaids} label="рейдов" />
          </div>
        </article>

        <section className="kb-team-panel kb-team-members-panel">
          <div className="kb-team-panel-head">
            <h2 className="kb-team-members-heading"><TabIcon section="kabanda" />Состав Кабанды</h2>
          </div>
          {members.length ? (
            <ul className="kb-team-members">
              {members.map((member) => (
                <li key={member.id}>
                  <span className="kb-team-avatar">
                    {member.avatarUrl ? <img src={member.avatarUrl} alt="" /> : member.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="kb-team-member-name"><strong>{member.displayName}</strong><small>{member.role === 'owner' ? 'Вожак' : 'Участник'}</small></span>
                  <span className={`kb-member-role${member.role === 'owner' ? ' is-owner' : ''}`}>{member.role === 'owner' ? 'Вожак' : 'Участник'}</span>
                </li>
              ))}
            </ul>
          ) : <p className="kb-muted">Состав пока не загрузился.</p>}
        </section>

        <InviteCreator kabandaId={kabanda.id} canInvite={kabanda.role === 'owner'} />

        <section className="kb-team-panel kb-team-account" aria-label="Аккаунт">
          <AlphaDiagnosticsConsent />
          <div className="kb-team-account-row">
            <div><h2>Аккаунт</h2><p>{user.username ? `@${user.username}` : user.email}</p></div>
            <button className="kb-switch-account" type="button" disabled={accountState === 'loading' || accountState === 'leaving' || (inventory?.activeRecordings ?? 0) > 0} onClick={onSwitchAccount}>
              <TeamScreenIcon name="logout" />{accountState === 'leaving' ? 'Выходим…' : 'Сменить аккаунт'}
            </button>
          </div>
          {inventory && inventory.activeRecordings > 0 ? <p className="kb-error" role="alert">Остановите запись текущего рейда перед сменой аккаунта.</p> : null}
          {accountState === 'error' ? <p className="kb-error" role="alert">Не удалось завершить выход. Проверьте соединение и повторите.</p> : null}
          {kabanda.role === 'member' && (
            <button className="kb-leave-team" type="button" disabled={membershipAction === 'me'} onClick={leave}>
              <TeamScreenIcon name="logout" />{membershipAction === 'me' ? 'Выходим…' : 'Выйти из Кабанды'}
            </button>
          )}
        </section>

        {adminDialog === 'rename' && (
          <div className="kb-team-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setAdminDialog(null)}>
            <form ref={node => { adminSheetRef.current = node }} className="kb-team-dialog" role="dialog" aria-modal="true" aria-labelledby="kb-rename-title" onSubmit={rename}>
              <button className="kb-team-dialog-close" type="button" aria-label="Закрыть" onClick={() => setAdminDialog(null)}>×</button>
              <h2 id="kb-rename-title">Переименовать Кабанду</h2>
              <label htmlFor="kb-rename-input">Новое название</label>
              <input id="kb-rename-input" required minLength={1} maxLength={80} value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} />
              <button className="kb-primary" type="submit" disabled={teamAction === 'rename'}>{teamAction === 'rename' ? 'Сохраняем…' : 'Сохранить'}</button>
            </form>
          </div>
        )}

        {adminDialog === 'members' && (
          <div className="kb-team-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setAdminDialog(null)}>
            <section ref={node => { adminSheetRef.current = node }} className="kb-team-dialog" role="dialog" aria-modal="true" aria-labelledby="kb-members-title">
              <button className="kb-team-dialog-close" type="button" aria-label="Закрыть" onClick={() => setAdminDialog(null)}>×</button>
              <h2 id="kb-members-title">Удалить участников</h2>
              <p>Вожак останется в Кабанде.</p>
              {members.some(({ role }) => role === 'member') ? (
                <ul className="kb-team-admin-members">
                  {members.filter(({ role }) => role === 'member').map((member) => (
                    <li key={member.id}>
                      <span className="kb-team-avatar">{member.avatarUrl ? <img src={member.avatarUrl} alt="" /> : member.displayName.slice(0, 1).toUpperCase()}</span>
                      <strong>{member.displayName}</strong>
                      <button type="button" disabled={membershipAction === member.id} onClick={() => void remove(member)}>{membershipAction === member.id ? 'Удаляем…' : 'Удалить'}</button>
                    </li>
                  ))}
                </ul>
              ) : <p className="kb-muted">Других участников пока нет.</p>}
            </section>
          </div>
        )}

        {adminDialog === 'leadership' && (
          <div className="kb-team-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setAdminDialog(null)}>
            <section ref={node => { adminSheetRef.current = node }} className="kb-team-dialog" role="dialog" aria-modal="true" aria-labelledby="kb-leadership-title">
              <button className="kb-team-dialog-close" type="button" aria-label="Закрыть" onClick={() => setAdminDialog(null)}>×</button>
              <h2 id="kb-leadership-title">Передать права вожака</h2>
              <p>Выберите нового вожака. После передачи он получит управление Кабандой.</p>
              {members.some(({ role }) => role === 'member') ? (
                <ul className="kb-team-admin-members kb-team-leadership-members">
                  {members.filter(({ role }) => role === 'member').map((member) => (
                    <li key={member.id}>
                      <span className="kb-team-avatar">{member.avatarUrl ? <img src={member.avatarUrl} alt="" /> : member.displayName.slice(0, 1).toUpperCase()}</span>
                      <strong>{member.displayName}</strong>
                      <button type="button" disabled={teamAction === 'leadership'} onClick={() => void handOverLeadership(member)}>{teamAction === 'leadership' ? 'Передаём…' : 'Передать'}</button>
                    </li>
                  ))}
                </ul>
              ) : <p className="kb-muted">Некому передать права — других участников пока нет.</p>}
            </section>
          </div>
        )}
      </div>
    </section>
  )

  return <>
    <RetainedScreen active={active && section === 'home'}>{homePanel}</RetainedScreen>
    <RetainedScreen active={mapActive}>{mapPanel}</RetainedScreen>
    <RetainedScreen active={active && section === 'raids'}>{raidsPanel}</RetainedScreen>
    <RetainedScreen active={active && section === 'kabanda'}>{teamPanel}</RetainedScreen>
  </>
}

async function prepareKabandaCover(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024) {
    throw new Error('Unsupported cover image')
  }
  const sourceUrl = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const value = new Image()
      value.onload = () => resolve(value)
      value.onerror = () => reject(new Error('Invalid image'))
      value.src = sourceUrl
    })
    const ratio = 2.05
    const width = Math.min(1280, image.naturalWidth)
    const height = Math.max(1, Math.round(width / ratio))
    const sourceRatio = image.naturalWidth / image.naturalHeight
    const sourceWidth = sourceRatio > ratio ? image.naturalHeight * ratio : image.naturalWidth
    const sourceHeight = sourceRatio > ratio ? image.naturalHeight : image.naturalWidth / ratio
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas unavailable')
    context.drawImage(
      image,
      (image.naturalWidth - sourceWidth) / 2,
      (image.naturalHeight - sourceHeight) / 2,
      sourceWidth,
      sourceHeight,
      0,
      0,
      width,
      height,
    )
    for (const quality of [0.78, 0.66, 0.54]) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality)
      if (dataUrl.length <= 420_000) return dataUrl
    }
    throw new Error('Compressed cover is too large')
  } finally {
    URL.revokeObjectURL(sourceUrl)
  }
}

function pluralizeMembers(count: number) {
  const mod100 = count % 100
  const mod10 = count % 10
  if (mod100 >= 11 && mod100 <= 14) return 'участников'
  if (mod10 === 1) return 'участник'
  if (mod10 >= 2 && mod10 <= 4) return 'участника'
  return 'участников'
}

export function TeamMetric({ icon, value, label }: { icon: 'point' | 'members' | 'bike'; value: number | null; label: string }) {
  return <div className="kb-team-metric"><span>{icon === 'point' ? <span className="kb-nav-icon kb-nav-icon--boar" aria-hidden="true" style={{ maskImage: `url(${appPath('brand/result-icons/boar-v3.png')})`, WebkitMaskImage: `url(${appPath('brand/result-icons/boar-v3.png')})` }} /> : icon === 'members' ? <span className="kb-nav-icon kb-nav-icon--kabanda" aria-hidden="true" style={{ maskImage: `url(${appPath('brand/result-icons/pack-v4.png')})`, WebkitMaskImage: `url(${appPath('brand/result-icons/pack-v4.png')})` }} /> : <TabIcon section="raids" />}</span><p><strong aria-label={value === null ? 'Данные ещё не получены' : undefined}>{value ?? '…'}</strong><small>{label}</small></p></div>
}

function TeamScreenIcon({ name }: { name: 'point' | 'members' | 'bike' | 'invite' | 'logout' }) {
  if (name === 'point') return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" /></svg>
  if (name === 'members') return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3.5 19v-1.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V19M14.5 14a4 4 0 0 1 6 3.5V19" /></svg>
  if (name === 'bike') return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="17" r="3.5" /><circle cx="18" cy="17" r="3.5" /><path d="m6 17 4-7h4l4 7m-8-7 3 7H6m5-10h4" /></svg>
  if (name === 'invite') return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></svg>
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5H5v14h5M13 8l4 4-4 4M8 12h9" /></svg>
}

function InviteCreator({ kabandaId, canInvite }: { kabandaId: string; canInvite: boolean }) {
  const [state, setState] = useState<'idle' | 'creating' | 'ready' | 'error'>('idle')
  const [link, setLink] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const create = async () => {
    if (state === 'creating') return
    setState('creating')
    try {
      const invite = await createInvite(kabandaId)
      setLink(`${appUrl('invite')}#invite=${encodeURIComponent(invite.token)}`)
      setExpiresAt(invite.expiresAt)
      setState('ready')
    } catch {
      setState('error')
    }
  }
  const reset = () => {
    setLink(null)
    setExpiresAt(null)
    setState('idle')
  }
  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
    } catch {
      setState('error')
    }
  }
  return (
    <section className="kb-team-panel kb-team-invite">
      <span className="kb-team-invite-icon"><TeamScreenIcon name="invite" /></span>
      <div className="kb-team-invite-copy"><h2>Приглашения</h2><p>Приглашайте друзей в команду — катайтесь вместе.</p></div>
      {!link ? (
        <button className="kb-invite-primary" type="button" onClick={create} disabled={!canInvite || state === 'creating'} title={!canInvite ? 'Приглашения создаёт вожак Кабанды' : undefined}>
          <TeamScreenIcon name="members" />{state === 'creating' ? 'Создаём ссылку…' : state === 'error' ? 'Повторить' : 'Пригласить участника'}
        </button>
      ) : <button className="kb-invite-primary" type="button" onClick={copy}><TeamScreenIcon name="invite" />Скопировать ссылку</button>}
      {!canInvite ? <small className="kb-team-invite-note">Ссылку может создать вожак.</small> : null}
      {link ? (
        <div className="kb-team-invite-result">
          <label htmlFor="invite-link">Одноразовое приглашение</label>
          <input id="invite-link" readOnly value={link} />
          {expiresAt && <small>Действует до {new Date(expiresAt).toLocaleString('ru-RU')}</small>}
          <button className="kb-text-action" type="button" onClick={reset}>Создать другую ссылку</button>
        </div>
      ) : null}
    </section>
  )
}

function Brand() {
  return <a className="kb-brand" href={appPath('app')} aria-label="КАБАНДА — на главную"><img src={appPath('brand/kabanda-logo-reference.png')} alt="" /><img className="kb-brand__wordmark" src={appPath('brand/kabanda-wordmark-ui.png')} alt="КАБАНДА" /></a>
}

function mapVisitState(point: MapPoint): VisitState {
  return point.visitState ?? (point.visitedByMe ? 'personal' : point.visitedByTeam ? 'team' : 'unvisited')
}
function mapMarkerClass(point: MapPoint, selected: boolean) {
  return `kb-yandex-marker kb-yandex-marker--${point.category} kb-visit--${mapVisitState(point)}${(point.visitedByMe || point.visitedByTeam) ? ' visited' : ''}${selected ? ' selected' : ''}`
}

function PointList({ points, selectedId, onSelect }: { points: readonly MapPoint[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (!points.length) return <div className="kb-empty-inline"><strong>Точек пока нет</strong><span>Когда вожак добавит места, они появятся здесь.</span></div>
  return <ul className="kb-point-list">{points.map((point) => <li key={point.id}><button type="button" aria-current={selectedId === point.id ? 'true' : undefined} onClick={() => onSelect(point.id)}><span className={`kb-dot kb-dot--${point.category} kb-visit--${mapVisitState(point)}${(point.visitedByMe || point.visitedByTeam) ? ' visited' : ''}`} aria-hidden="true" /><span><strong>{point.name}</strong>{point.category === 'stores' && <small>{point.address}</small>}<small>{visitStateLabel(mapVisitState(point))}</small></span><b aria-hidden="true">›</b></button></li>)}</ul>
}

const USER_LOCATION_MAP_ZOOM = 14
const MIN_MAP_ZOOM = 10
const MAX_MAP_ZOOM = 17

function PointsMap({ visible, points, selectedId, onSelect, setProviderState, memory, identityId, kabandaId, historyPrefetchEnabled }: { visible: boolean; points: readonly MapPoint[]; selectedId: string | null; onSelect: (id: string | null) => void; setProviderState: (state: ProviderState) => void; memory: MapViewportMemory; identityId: string; kabandaId: string; historyPrefetchEnabled: boolean }) {
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const containerRef = useRef<HTMLDivElement>(null)
  const backgroundTap = useRef(new MapBackgroundTap())
  const mapRef = useRef<YandexMap | null>(null)
  const runtimeRef = useRef<YandexMapsRuntime | null>(null)
  const markersRef = useRef<MapMarkers<MapPoint> | null>(null)
  const cameraRef = useRef<MapCamera | null>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const userMarkerRef = useRef<YandexPlacemark | null>(null)
  const locationRequestRef = useRef(0)
  const autoLocateStartedRef = useRef(false)
  const viewRef = useRef<MapView>(memory.read())
  const [mapReady, setMapReady] = useState(false)
  const [userLocated, setUserLocated] = useState(false)
  const [zoom, setZoom] = useState(() => memory.read().zoom)
  const [settledView, setSettledView] = useState(() => memory.read())
  const historyPoints = useMemo(() => points.flatMap(point => {
    const id = point.category === 'attractions' ? point.id : point.historyPointId
    return id ? [{ id, latitude: point.latitude, longitude: point.longitude }] : []
  }), [points])
  const selected = points.find(point => point.id === selectedId)
  useNearbyPointHistory({ identityId, kabandaId, points: historyPoints,
    anchor: { latitude: settledView.center[1], longitude: settledView.center[0] },
    priorityPointId: selected?.category === 'attractions' ? selected.id : selected?.historyPointId,
    active: visible && historyPrefetchEnabled && mapReady,
  })
  const [geolocationError, setGeolocationError] = useState<string | null>(() =>
    'geolocation' in navigator ? null : 'Геолокация недоступна на этом устройстве.',
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let active = true
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    let detachTiles = () => {}
    const resize = new ResizeObserver(() => {
      if (visibleRef.current && document.visibilityState === 'visible') mapRef.current?.container?.fitToViewport?.()
    })
    resize.observe(container)
    const apiKey = import.meta.env.VITE_YANDEX_MAPS_API_KEY?.trim() ?? ''
    setProviderState('checking')

    void loadYandexMaps(apiKey).then((runtime) => {
      if (!active) return
      const view = memory.read()
      viewRef.current = view
      const map = new runtime.Map(container, {
        center: [view.center[1], view.center[0]],
        zoom: view.zoom,
        controls: [],
        behaviors: ['default', 'scrollZoom'],
        type: 'yandex#map',
      }, { suppressMapOpenBlock: true })
      map.events.add('boundschange', (event) => {
        const nextCenter = event.get('newCenter') as readonly [number, number] | undefined
        const nextZoom = event.get('newZoom') as number | undefined
        if (!nextCenter || nextZoom === undefined) return
        viewRef.current = { center: [nextCenter[1], nextCenter[0]], zoom: nextZoom }
        memory.remember(viewRef.current)
        clearTimeout(settleTimer)
        settleTimer = setTimeout(() => {
          if (!active || !visibleRef.current) return
          setZoom(viewRef.current.zoom)
          setSettledView(viewRef.current)
        }, 300)
      })
      runtimeRef.current = runtime
      mapRef.current = map
      detachTiles = attachYandexTileCache(map, runtime, container)
      cameraRef.current = new MapCamera(map, () => matchMedia('(prefers-reduced-motion: reduce)').matches)
      markersRef.current = new MapMarkers(map, runtime,
        '<button type="button" class="{{ properties.markerClass }}" aria-label="{{ properties.ariaLabel }}" aria-pressed="{{ properties.selected }}"></button>',
        point => onSelectRef.current(point.id))
      setMapReady(true)
      setProviderState('ready')
    }).catch(() => {
      if (active) setProviderState('failed')
    })

    return () => {
      detachTiles()
      resize.disconnect()
      clearTimeout(settleTimer)
      active = false
      locationRequestRef.current += 1
      const map = mapRef.current
      if (map) {
        const center = map.getCenter()
        memory.remember({ center: [center[1], center[0]], zoom: map.getZoom() })
      }
      setMapReady(false)
      markersRef.current?.clear()
      markersRef.current = null
      cameraRef.current?.stop()
      cameraRef.current = null
      userMarkerRef.current = null
      runtimeRef.current = null
      mapRef.current?.destroy()
      mapRef.current = null
    }
  }, [setProviderState, memory])

  useEffect(() => {
    if (!mapReady || !visible) return
    markersRef.current?.update(points, point => {
      const selected = selectedId === point.id
      return {
        coordinate: [point.latitude, point.longitude],
        properties: {
          markerClass: mapMarkerClass(point, selected),
          ariaLabel: `${point.name}. ${point.category === 'stores' ? `${point.address}. ` : ''}${visitStateLabel(mapVisitState(point))}`,
          selected: String(selected),
        },
        options: {
          iconShape: { type: 'Circle', coordinates: [0, 0], radius: 14 },
          hasBalloon: false, hasHint: false, openBalloonOnClick: false,
          openHintOnHover: false, interactiveZIndex: false, zIndex: selected ? 24 : 20,
        },
      }
    })
  }, [mapReady, points, selectedId, visible])

  const updateLocation = useCallback((location: { center?: readonly [number, number]; zoom?: number }, duration = 650) => {
    const map = mapRef.current
    if (!map) return
    if (location.center) {
      // Explicit centering preserves the user's zoom and animates even across
      // distant viewports; the SDK handles the flight and tile transitions.
      if (location.zoom === undefined) cameraRef.current?.center([location.center[1], location.center[0]])
      else void map.setCenter([location.center[1], location.center[0]], location.zoom, {
        duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : duration,
        timingFunction: 'ease-in-out',
      })
      return
    }
    if (location.zoom !== undefined) cameraRef.current?.zoom(location.zoom)
  }, [])

  const locateUser = useCallback((accuracy: 'fast' | 'precise' = 'precise', automatic = false) => {
    if (!('geolocation' in navigator)) {
      setGeolocationError('Геолокация недоступна на этом устройстве.')
      return
    }
    const requestedMap = mapRef.current
    if (!requestedMap) return
    const request = ++locationRequestRef.current
    setGeolocationError(null)
    navigator.geolocation.getCurrentPosition((position) => {
      const location = [position.coords.longitude, position.coords.latitude] as const
      const map = mapRef.current
      const runtime = runtimeRef.current
      if (!visibleRef.current || document.visibilityState !== 'visible' || !map || !runtime || map !== requestedMap || request !== locationRequestRef.current) return
      if (userMarkerRef.current) userMarkerRef.current.geometry?.setCoordinates([location[1], location[0]])
      else {
        const userLayout = runtime.templateLayoutFactory.createClass('<span class="kb-yandex-user-location" aria-label="Моё местоположение"></span>')
        userMarkerRef.current = new runtime.Placemark([location[1], location[0]], {}, {
          iconLayout: userLayout,
          iconShape: { type: 'Circle', coordinates: [0, 0], radius: 23 },
          hasBalloon: false,
          hasHint: false,
          zIndex: 10,
        })
        map.geoObjects.add(userMarkerRef.current)
      }
      setUserLocated(true)
      if (!automatic || memory.canAutoCenter()) updateLocation({ center: location, ...(automatic ? { zoom: USER_LOCATION_MAP_ZOOM } : {}) })
    }, () => {
      if (!visibleRef.current || mapRef.current !== requestedMap || request !== locationRequestRef.current) return
      setGeolocationError('Не удалось определить положение. Разрешите геолокацию для Кабанды и повторите.')
    }, accuracy === 'fast'
      ? { enableHighAccuracy: false, maximumAge: 300_000, timeout: 8_000 }
      : { enableHighAccuracy: true, maximumAge: 15_000, timeout: 12_000 })
  }, [updateLocation, memory])

  useEffect(() => {
    const resume = () => {
      if (!visible || !mapReady || document.visibilityState !== 'visible') {
        locationRequestRef.current++
        autoLocateStartedRef.current = false
        cameraRef.current?.stop()
        return
      }
      mapRef.current?.container?.fitToViewport?.()
      if (autoLocateStartedRef.current) return
      autoLocateStartedRef.current = true
      locateUser('fast', true)
    }
    resume()
    document.addEventListener('visibilitychange', resume)
    return () => { document.removeEventListener('visibilitychange', resume) }
  }, [locateUser, mapReady, visible])

  return <>
    <div className="kb-map kb-yandex-map" data-kabanda-map role="group" aria-label="Карта точек Ижевска" onPointerDownCapture={event => { memory.userInteracted(); if (!event.isPrimary) backgroundTap.current.cancel() }} onWheelCapture={() => { memory.userInteracted(); backgroundTap.current.cancel() }} onKeyDownCapture={() => memory.userInteracted()}>
      <div ref={containerRef} className="kb-yandex-map-stage"
        onPointerDownCapture={event => {
          if (event.target instanceof Element && event.target.closest('button, a, input, select, textarea')) { backgroundTap.current.cancel(); return }
          backgroundTap.current.down(event)
        }}
        onPointerMoveCapture={event => backgroundTap.current.move(event)}
        onPointerUpCapture={event => {
          if (!backgroundTap.current.up(event)) return
          const markers = [...event.currentTarget.querySelectorAll<HTMLElement>('.kb-yandex-marker, .kb-yandex-user-location')]
          if (!isMapMarkerHit(event.clientX, event.clientY, markers.map(marker => marker.getBoundingClientRect()))) onSelectRef.current(null)
        }}
        onPointerCancelCapture={() => backgroundTap.current.cancel()} />
      <div className="kb-yandex-zoom" aria-label="Масштаб карты">
        <button type="button" aria-label="Приблизить" disabled={!mapReady || zoom >= MAX_MAP_ZOOM} onClick={() => updateLocation({ zoom: Math.min(MAX_MAP_ZOOM, viewRef.current.zoom + 1) })}>+</button>
        <button type="button" aria-label="Отдалить" disabled={!mapReady || zoom <= MIN_MAP_ZOOM} onClick={() => updateLocation({ zoom: Math.max(MIN_MAP_ZOOM, viewRef.current.zoom - 1) })}>−</button>
        <button className="kb-yandex-locate" type="button" aria-label="Показать моё местоположение" aria-pressed={userLocated} disabled={!mapReady} onClick={() => locateUser('precise')}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20.62 3.38 4.15 9.56a1 1 0 0 0 .08 1.9l6.27 2.04 2.04 6.27a1 1 0 0 0 1.9.08l6.18-16.47Z" /></svg>
        </button>
      </div>
    </div>
    {geolocationError ? <p className="kb-map-geolocation-error" role="alert">{geolocationError}</p> : null}
  </>
}
