import '@fontsource-variable/manrope'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type Dispatch, type FormEvent, type SetStateAction } from 'react'
import type { User } from '@kabanda/contracts'
import { ApiError } from '../../lib/http'
import { appPath, appUrl } from '../../lib/paths'
import { AppTabBar } from '../../app/AppTabBar'
import {
  appSectionSearch,
  parseAppSection,
  resolveSelectedKabandaId,
  type AppSection,
} from '../../app/navigation'
import { getCurrentUser, loginWithPassword, logout } from '../auth/api'
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
import { loadMapLibre } from './maplibre'
import { IZHEVSK_KB_STORES, IZHEVSK_KB_STORES_UPDATED_AT } from './izhevsk-kb-stores'
import { useKabandaMotion } from './useKabandaMotion'
import { RaidHomeCard } from '../raids/RaidHomeCard'
import { getKabandaProgress } from '../results/api'
import { RaidHistory } from '../results/RaidHistory'
import type { KabandaProgress } from '../results/types'
import type {
  KabandaMember,
  KabandaPoint,
  KabandaSummary,
  PointPresentation,
  ProviderState,
} from './types'
import './kabandas.css'

type Session = { state: 'loading' } | { state: 'anonymous' } | { state: 'ready'; user: User }

type MapPointCategory = 'stores' | 'attractions'
type MapPoint = KabandaPoint & {
  category: MapPointCategory
  address?: string
  hours?: string
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
  category: 'stores',
  address: store.address,
  hours: store.hours,
}))

export function KabandasPage() {
  const [session, setSession] = useState<Session>({ state: 'loading' })

  useEffect(() => {
    let active = true
    getCurrentUser()
      .then((user) => active && setSession({ state: 'ready', user }))
      .catch((error) => {
        if (!active) return
        setSession(error instanceof ApiError && error.status === 401 ? { state: 'anonymous' } : { state: 'anonymous' })
      })
    return () => {
      active = false
    }
  }, [])

  if (session.state === 'loading') {
    return <main className="kb-shell kb-center" aria-busy="true">Загружаем КАБАНДУ…</main>
  }
  if (session.state === 'anonymous') return <SignInPanel />
  return <AuthenticatedKabandas user={session.user} onLoggedOut={() => setSession({ state: 'anonymous' })} />
}

function SignInPanel() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'error'>('idle')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (state === 'sending') return
    setState('sending')
    try {
      await loginWithPassword(username, password)
      window.location.reload()
    } catch {
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
          {state === 'error' && <p className="kb-error" role="alert">Не удалось войти. Проверьте данные и повторите.</p>}
        </div>
      </section>
    </main>
  )
}

function AuthenticatedKabandas({ user, onLoggedOut }: { user: User; onLoggedOut: () => void }) {
  const [kabandas, setKabandas] = useState<KabandaSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [routeSearch, setRouteSearch] = useState(window.location.search)
  const [inventory, setInventory] = useState<IdentityLocalInventory | null>(null)
  const [accountState, setAccountState] = useState<'idle' | 'loading' | 'leaving' | 'error'>('idle')
  const activeSection = parseAppSection(routeSearch)
  const requestedKabandaId = new URLSearchParams(routeSearch).get('kabanda')

  useEffect(() => {
    const restoreRoute = () => setRouteSearch(window.location.search)
    window.addEventListener('popstate', restoreRoute)
    return () => window.removeEventListener('popstate', restoreRoute)
  }, [])

  useEffect(() => {
    let active = true
    listKabandas()
      .then((items) => {
        if (!active) return
        setKabandas(items)
        setSelectedId((current) => resolveSelectedKabandaId(items.map(({ id }) => id), requestedKabandaId, current))
      })
      .catch(() => active && setError('Не удалось загрузить Кабанды.'))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [requestedKabandaId])

  const selected = kabandas.find(({ id }) => id === selectedId) ?? null
  const addKabanda = (kabanda: KabandaSummary) => {
    setKabandas((items) => [kabanda, ...items.filter(({ id }) => id !== kabanda.id)])
    setSelectedId(kabanda.id)
    setShowCreate(false)
  }
  const removeKabandaLocally = (kabandaId: string) => {
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
    window.history.pushState(null, '', `${appPath('app')}${search}`)
    setRouteSearch(search)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const selectKabanda = (kabandaId: string) => {
    setSelectedId(kabandaId)
    const search = appSectionSearch(window.location.search, activeSection, kabandaId)
    window.history.replaceState(null, '', `${appPath('app')}${search}`)
    setRouteSearch(search)
  }

  useEffect(() => {
    if (activeSection !== 'kabanda') return
    setAccountState('loading')
    void getIdentityLocalInventory(user.id)
      .then((value) => {
        setInventory(value)
        setAccountState('idle')
      })
      .catch(() => setAccountState('error'))
  }, [activeSection, user.id])
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

  return (
    <main className={`kb-shell kb-shell--tabs${activeSection === 'map' ? ' kb-shell--map' : ''}${activeSection === 'kabanda' ? ' kb-shell--team' : ''}`}>
      <header className="kb-topbar">
        <Brand />
        <button className="kb-identity kb-account-trigger" type="button" aria-current={activeSection === 'kabanda' ? 'page' : undefined} onClick={() => selectSection('kabanda')} aria-label={`Открыть раздел «Кабанда». Аккаунт: ${user.displayName ?? user.username ?? user.email ?? 'Участник'}`}>
          <span>{(user.displayName ?? user.username ?? user.email ?? 'У').slice(0, 1).toUpperCase()}</span>
          {activeSection !== 'kabanda' && <div><strong>{user.displayName ?? user.username ?? 'Участник'}</strong><small>{user.username ? `@${user.username}` : user.email}</small></div>}
        </button>
      </header>

      {activeSection !== 'kabanda' && <section className="kb-heading-row">
        <div><h1>{sectionHeading(activeSection).title}</h1><p>{sectionHeading(activeSection).description}</p></div>
      </section>}

      {activeSection === 'home' && <InstallGuidance />}

      {activeSection === 'kabanda' && user.identityKind === 'verified' && showCreate && <CreateKabandaForm onCreated={addKabanda} onCancel={() => setShowCreate(false)} />}
      {error && <p className="kb-error" role="alert">{error}</p>}
      {loading ? <p className="kb-muted" aria-busy="true">Загружаем команды…</p> : null}

      {!loading && kabandas.length === 0 && !showCreate && (
        <section className="kb-card kb-empty"><h2>Пока без Кабанды</h2><p>Создайте первую команду или откройте приглашение, которое вам прислали.</p>{user.identityKind === 'verified' ? <button className="kb-primary" type="button" onClick={() => { selectSection('kabanda'); setShowCreate(true) }}>Создать Кабанду</button> : null}</section>
      )}

      {selected && !showCreate && <KabandaWorkspace
        key={selected.id}
        user={user}
        kabanda={selected}
        section={activeSection}
        inventory={inventory}
        accountState={accountState}
        onLeft={() => removeKabandaLocally(selected.id)}
        onKabandaUpdated={updateKabandaLocally}
        onSwitchAccount={() => void leaveAccount()}
      />}
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
  inventory,
  accountState,
  onLeft,
  onKabandaUpdated,
  onSwitchAccount,
}: {
  user: User
  kabanda: KabandaSummary
  section: AppSection
  inventory: IdentityLocalInventory | null
  accountState: 'idle' | 'loading' | 'leaving' | 'error'
  onLeft: () => void
  onKabandaUpdated: (kabanda: KabandaSummary) => void
  onSwitchAccount: () => void
}) {
  const workspaceRef = useRef<HTMLElement>(null)
  const [members, setMembers] = useState<KabandaMember[]>([])
  const [points, setPoints] = useState<KabandaPoint[]>([])
  const [progress, setProgress] = useState<KabandaProgress | null>(null)
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
  const [renameDraft, setRenameDraft] = useState(kabanda.name)
  const [teamAction, setTeamAction] = useState<'rename' | 'cover' | 'leadership' | null>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)
  const webglAvailable = useMemo(detectWebgl, [])
  const attractionPoints = useMemo<MapPoint[]>(() => points.map((point) => ({ ...point, category: 'attractions' })), [points])
  const visiblePoints = pointCategory === 'stores' ? STORE_MAP_POINTS : attractionPoints
  const activeProviderState = pointCategory === 'attractions'
    ? attractionState === 'failed' ? 'failed' : attractionState === 'checking' ? 'checking' : providerState
    : providerState
  const presentation = choosePointPresentation(requestedView, activeProviderState, webglAvailable)
  useKabandaMotion(workspaceRef)

  useEffect(() => {
    let active = true
    listMembers(kabanda.id).then((value) => active && setMembers(value)).catch(() => active && setMessage('Участники временно недоступны.'))
    const collectionId = kabanda.pointsCollectionId
    if (!collectionId) {
      setAttractionState('failed')
      setPointMessage('Вожак ещё не загрузил набор достопримечательностей.')
      return () => {
        active = false
      }
    }
    listPoints(collectionId, [53.06, 56.74, 53.31, 56.94], 100)
      .then(async ({ points: fresh }) => {
        if (!active) return
        setPoints(fresh)
        setAttractionState('ready')
        setPointMessage(null)
        setStaleAt(null)
        await savePointProjection(user.id, kabanda.id, collectionId, fresh)
      })
      .catch(async () => {
        const cached = await readPointProjection(user.id, kabanda.id, collectionId)
        if (!active) return
        setAttractionState(cached ? 'ready' : 'failed')
        if (cached) {
          setPoints(cached.points)
          setStaleAt(cached.savedAt)
        } else {
          setPointMessage('Достопримечательности недоступны без сети и ещё не сохранены на этом устройстве.')
        }
      })
    return () => {
      active = false
    }
  }, [kabanda, user.id, webglAvailable])

  useEffect(() => {
    if (section !== 'kabanda') return
    let active = true
    void getKabandaProgress(kabanda.id)
      .then((value) => active && setProgress(value))
      .catch(() => active && setProgress(null))
    return () => {
      active = false
    }
  }, [kabanda.id, section])

  const selectedPoint = visiblePoints.find(({ id }) => id === selectedPointId) ?? null
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
    {pointCategory === 'attractions' && staleAt && <p className="kb-stale" role="status">Офлайн-копия от {new Date(staleAt).toLocaleString('ru-RU')}. Она привязана к вашему аккаунту.</p>}
    {section === 'map' && pointCategory === 'attractions' && pointMessage && <p className="kb-notice" role="status">{pointMessage}</p>}
    {message && <p className="kb-notice" role="status">{message}</p>}
  </>

  const summary = <div className="kb-summary">
    <div><h2>{kabanda.name}</h2><p>{kabanda.role === 'owner' ? 'Вы вожак' : 'Вы участник'}</p></div>
    <p><strong>{points.filter(({ visitedByMe }) => visitedByMe).length}</strong><span>посещено лично</span></p>
    <p><strong>{points.filter(({ visitedByTeam }) => visitedByTeam).length}</strong><span>посетила команда</span></p>
  </div>

  if (section === 'home') {
    return (
      <section className="kb-workspace" ref={workspaceRef}>
        <aside className="kb-journey-rail" data-journey-rail>
          {summary}
          <p className="kb-route-statement" data-route-statement aria-label="Сначала соберите людей. Затем отправляйтесь к точкам. После сохраните общую историю.">
            {'Сначала соберите людей. Затем отправляйтесь к точкам. После сохраните общую историю.'.split(' ').map((word, index) => <span key={`${word}-${index}`}>{word} </span>)}
          </p>
        </aside>
        <div className="kb-workspace-main">
          {notices}
          <RaidHomeCard identityId={user.id} kabanda={kabanda} />
        </div>
      </section>
    )
  }

  if (section === 'map') {
    return (
      <section className="kb-map-screen" ref={workspaceRef} aria-label="Точки маршрута">
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
          {presentation === 'map' && visiblePoints.length > 0 ? <PointsMap points={visiblePoints} selectedId={selectedPointId} onSelect={setSelectedPointId} setProviderState={setProviderState} /> : null}
          {(presentation === 'list' || visiblePoints.length === 0) && (
            <div className="kb-map-list-panel">
              <PointList points={visiblePoints} selectedId={selectedPointId} onSelect={setSelectedPointId} />
              {activeProviderState === 'failed' && visiblePoints.length > 0 && <p className="kb-muted">Карта сейчас недоступна. Точки остаются доступны списком.</p>}
            </div>
          )}
          {selectedPoint && (
            <aside className="kb-point-sheet" aria-label={`Точка: ${selectedPoint.name}`}>
              <button className="kb-point-sheet-close" type="button" aria-label="Закрыть информацию о точке" onClick={() => setSelectedPointId(null)}>×</button>
              <PointDetail point={selectedPoint} />
            </aside>
          )}
        </div>
      </section>
    )
  }

  if (section === 'raids') {
    return (
      <section className="kb-workspace kb-workspace--single" ref={workspaceRef}>
        <div className="kb-workspace-main kb-workspace-main--wide">
          {notices}
          <div className="kb-command-grid">
            <RaidHomeCard identityId={user.id} kabanda={kabanda} />
            <RaidHistory identityId={user.id} kabandaId={kabanda.id} />
          </div>
        </div>
      </section>
    )
  }

  const personalPoints = points.filter(({ visitedByMe }) => visitedByMe).length
  const teamPoints = points.filter(({ visitedByTeam }) => visitedByTeam).length
  const completedRaids = progress?.team.completedRaids ?? 0
  const memberCount = members.length || kabanda.memberCount
  const roleLabel = kabanda.role === 'owner' ? 'Вы вожак' : 'Вы участник'

  return (
    <section className="kb-team-page" ref={workspaceRef}>
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
          <div className="kb-team-stats" aria-label="Статистика Кабанды">
            <TeamMetric icon="point" value={personalPoints} label="точек лично" />
            <TeamMetric icon="members" value={teamPoints} label="точек команды" />
            <TeamMetric icon="bike" value={completedRaids} label="рейдов" />
          </div>
        </article>

        <section className="kb-team-panel kb-team-members-panel">
          <div className="kb-team-panel-head">
            <h2>Состав Кабанды</h2>
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
            <form className="kb-team-dialog" role="dialog" aria-modal="true" aria-labelledby="kb-rename-title" onSubmit={rename}>
              <button className="kb-team-dialog-close" type="button" aria-label="Закрыть" onClick={() => setAdminDialog(null)}>×</button>
              <h2 id="kb-rename-title">Переименовать Кабанду</h2>
              <label htmlFor="kb-rename-input">Новое название</label>
              <input id="kb-rename-input" autoFocus required minLength={1} maxLength={80} value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} />
              <button className="kb-primary" type="submit" disabled={teamAction === 'rename'}>{teamAction === 'rename' ? 'Сохраняем…' : 'Сохранить'}</button>
            </form>
          </div>
        )}

        {adminDialog === 'members' && (
          <div className="kb-team-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setAdminDialog(null)}>
            <section className="kb-team-dialog" role="dialog" aria-modal="true" aria-labelledby="kb-members-title">
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
            <section className="kb-team-dialog" role="dialog" aria-modal="true" aria-labelledby="kb-leadership-title">
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

function TeamMetric({ icon, value, label }: { icon: 'point' | 'members' | 'bike'; value: number; label: string }) {
  return <div className="kb-team-metric"><span><TeamScreenIcon name={icon} /></span><p><strong>{value}</strong><small>{label}</small></p></div>
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
  return <a className="kb-brand" href={appPath('app')} aria-label="КАБАНДА — на главную"><img src={appPath('brand/kabanda-logo-reference.png')} alt="" /><strong>КАБАНДА</strong></a>
}

function PointList({ points, selectedId, onSelect }: { points: readonly MapPoint[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (!points.length) return <div className="kb-empty-inline"><strong>Точек пока нет</strong><span>Когда вожак добавит места, они появятся здесь.</span></div>
  return <ul className="kb-point-list">{points.map((point) => <li key={point.id}><button type="button" aria-current={selectedId === point.id ? 'true' : undefined} onClick={() => onSelect(point.id)}><span className={`kb-dot kb-dot--${point.category}${point.visitedByMe ? ' visited' : ''}`} aria-hidden="true" /><span><strong>{point.name}</strong><small>{point.category === 'stores' ? point.address : point.visitedByMe ? 'Вы были здесь' : point.visitedByTeam ? 'Команда уже была' : 'Ещё не посещали'}</small></span><b aria-hidden="true">›</b></button></li>)}</ul>
}

function PointsMap({ points, selectedId, onSelect, setProviderState }: { points: readonly MapPoint[]; selectedId: string | null; onSelect: (id: string) => void; setProviderState: Dispatch<SetStateAction<ProviderState>> }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const trackingRequestedRef = useRef(false)
  const [geolocationError, setGeolocationError] = useState<string | null>(() =>
    'geolocation' in navigator ? null : 'Геолокация недоступна на этом устройстве.',
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let destroyed = false
    let teardown: (() => void) | undefined
    const shouldResumeTracking = trackingRequestedRef.current
    void loadMapLibre().then(({ GeolocateControl, Map, Marker }) => {
      if (destroyed) return
      const map = new Map({
        container,
        center: [53.2045, 56.8528],
        zoom: 11.3,
        minZoom: 10,
        maxZoom: 18,
        maxBounds: [[53.06, 56.74], [53.34, 56.95]],
        locale: {
          'GeolocateControl.FindMyLocation': 'Определить моё местоположение',
          'GeolocateControl.LocationNotAvailable': 'Геолокация недоступна',
        },
        style: {
          version: 8,
          sources: {
            osm: {
              type: 'raster',
              tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
              tileSize: 256,
              maxzoom: 19,
              attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            },
          },
          layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
        },
      })
      map.on('error', () => !destroyed && setProviderState('failed'))
      const geolocate = new GeolocateControl({
        positionOptions: { enableHighAccuracy: true, maximumAge: 5_000, timeout: 12_000 },
        fitBoundsOptions: { maxZoom: 16 },
        trackUserLocation: true,
        showAccuracyCircle: true,
        showUserLocation: true,
      })
      geolocate.on('trackuserlocationstart', () => {
        if (destroyed) return
        trackingRequestedRef.current = true
        setGeolocationError(null)
      })
      geolocate.on('trackuserlocationend', () => {
        if (!destroyed) trackingRequestedRef.current = false
      })
      geolocate.on('geolocate', () => !destroyed && setGeolocationError(null))
      geolocate.on('error', () => {
        if (!destroyed) setGeolocationError('Не удалось определить положение. Разрешите геолокацию для Кабанды и повторите.')
      })
      map.addControl(geolocate, 'bottom-left')
      map.once('load', () => {
        if (destroyed) return
        setProviderState('ready')
        if (shouldResumeTracking) geolocate.trigger()
      })
      const markers = points.map((point) => {
        const element = document.createElement('button')
        element.type = 'button'
        element.dataset.pointId = point.id
        element.className = `kb-map-marker kb-map-marker--${point.category}${point.visitedByMe ? ' visited' : ''}${selectedId === point.id ? ' selected' : ''}`
        element.setAttribute('aria-label', point.category === 'stores'
          ? `${point.name}. ${point.address}`
          : `${point.name}. ${point.visitedByMe ? 'Посещено лично' : point.visitedByTeam ? 'Посещено командой' : 'Не посещено'}`)
        element.setAttribute('aria-pressed', String(selectedId === point.id))
        element.addEventListener('click', () => onSelect(point.id))
        return new Marker({ element }).setLngLat([point.longitude, point.latitude]).addTo(map)
      })
      teardown = () => {
        markers.forEach((marker) => marker.remove())
        map.remove()
      }
    }).catch(() => !destroyed && setProviderState('failed'))
    return () => {
      destroyed = true
      teardown?.()
    }
  }, [onSelect, points, setProviderState])

  useEffect(() => {
    const markers = containerRef.current?.querySelectorAll<HTMLElement>('[data-point-id]') ?? []
    markers.forEach((marker) => {
      const selected = marker.dataset.pointId === selectedId
      marker.classList.toggle('selected', selected)
      marker.setAttribute('aria-pressed', String(selected))
    })
  }, [selectedId])

  return <>
    <div ref={containerRef} className="kb-map" data-kabanda-map role="group" aria-label="Карта точек Ижевска" />
    {geolocationError ? <p className="kb-map-geolocation-error" role="alert">{geolocationError}</p> : null}
  </>
}

function PointDetail({ point }: { point: MapPoint }) {
  const times = (count: number) => {
    const lastTwo = count % 100
    if (lastTwo >= 11 && lastTwo <= 14) return 'раз'
    const last = count % 10
    return last >= 2 && last <= 4 ? 'раза' : 'раз'
  }
  if (point.category === 'stores') {
    return <>
      <p className="kb-point-eyebrow">Красное&amp;Белое</p>
      <h2>{point.address}</h2>
      <p className="kb-point-place">Ижевск</p>
      {point.hours && <p className="kb-point-hours"><span>Часы работы</span><strong>{point.hours}</strong></p>}
      <p className="kb-point-source">Официальный каталог сети · обновлено {new Date(`${IZHEVSK_KB_STORES_UPDATED_AT}T00:00:00`).toLocaleDateString('ru-RU')}</p>
    </>
  }
  return <>
    <h2>{point.name}</h2>
    <p className="kb-point-place">Ижевск</p>
    <div className="kb-point-visits" aria-label="Посещения точки">
      <p aria-label={`Вы посетили эту точку ${point.visitedByMeCount} ${times(point.visitedByMeCount)}`}><span>Вы</span><strong>{point.visitedByMeCount}</strong><small>{times(point.visitedByMeCount)}</small></p>
      <p aria-label={`Команда посетила эту точку ${point.visitedByTeamCount} ${times(point.visitedByTeamCount)}`}><span>Команда</span><strong>{point.visitedByTeamCount}</strong><small>{times(point.visitedByTeamCount)}</small></p>
    </div>
  </>
}
