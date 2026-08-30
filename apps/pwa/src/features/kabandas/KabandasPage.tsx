import '@fontsource-variable/manrope'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react'
import type { User } from '@kabanda/contracts'
import { ApiError } from '../../lib/http'
import { appPath, appUrl } from '../../lib/paths'
import { getCurrentUser, loginWithPassword, logout, requestMagicLink } from '../auth/api'
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
} from './api'
import { readPointProjection, savePointProjection } from './cache'
import { choosePointPresentation, detectWebgl } from './map-state'
import { loadMapLibre } from './maplibre'
import { useKabandaMotion } from './useKabandaMotion'
import { RaidHomeCard } from '../raids/RaidHomeCard'
import { RaidHistory } from '../results/RaidHistory'
import type {
  KabandaMember,
  KabandaPoint,
  KabandaSummary,
  PointPresentation,
  ProviderState,
} from './types'
import './kabandas.css'

type Session = { state: 'loading' } | { state: 'anonymous' } | { state: 'ready'; user: User }

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
  const [mode, setMode] = useState<'password' | 'email'>('password')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (state === 'sending') return
    setState('sending')
    try {
      if (mode === 'password') {
        await loginWithPassword(username, password)
        window.location.reload()
      } else {
        await requestMagicLink(email, appPath('app'))
        setState('sent')
      }
    } catch {
      setState('error')
    }
  }

  return (
    <main className="kb-shell kb-center kb-auth-shell">
      <section className="kb-auth-layout kb-login-layout">
        <div className="kb-login-visual" aria-hidden="true">
          <img
            src={appPath('brand/kabanda-login-riders.jpg')}
            alt=""
            width="907"
            height="1734"
            decoding="async"
            fetchPriority="high"
          />
        </div>
        <div className="kb-auth-form">
          <div className="kb-auth-heading">
            <span className="kb-inline-mark" aria-hidden="true"><img src={appPath('brand/kabanda-logo-reference.png')} alt="" /></span>
            <h2>Войти в Кабанду</h2>
            <p>Используйте данные, которые придумали при вступлении по приглашению.</p>
          </div>
          {state === 'sent' ? (
            <p className="kb-notice" role="status">Ссылка отправлена. Откройте письмо на этом устройстве.</p>
          ) : (
            <form onSubmit={submit}>
              {mode === 'password' ? <>
                <label htmlFor="kb-username">Логин</label>
                <input id="kb-username" autoComplete="username" required minLength={3} maxLength={32} value={username} onChange={(event) => setUsername(event.target.value)} />
                <label htmlFor="kb-password">Пароль</label>
                <input id="kb-password" type="password" autoComplete="current-password" required minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} />
                <p className="kb-auth-help">Забыли пароль? Попросите администратора задать новый временный пароль.</p>
              </> : <>
                <label htmlFor="kb-email">Электронная почта</label>
                <input id="kb-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
              </>}
              <button className="kb-primary" type="submit" disabled={state === 'sending'}>
                {state === 'sending' ? 'Входим…' : mode === 'password' ? 'Войти' : 'Получить ссылку'}
              </button>
            </form>
          )}
          {state === 'error' && <p className="kb-error" role="alert">Не удалось войти. Проверьте данные и повторите.</p>}
          {state !== 'sent' && <button className="kb-text-action" type="button" onClick={() => { setMode((value) => value === 'password' ? 'email' : 'password'); setState('idle') }}>{mode === 'password' ? 'Войти через почту' : 'Войти по логину и паролю'}</button>}
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
  const [showAccount, setShowAccount] = useState(false)
  const [inventory, setInventory] = useState<IdentityLocalInventory | null>(null)
  const [accountState, setAccountState] = useState<'idle' | 'loading' | 'leaving' | 'error'>('idle')
  const requestedKabandaId = new URLSearchParams(window.location.search).get('kabanda')

  useEffect(() => {
    let active = true
    listKabandas()
      .then((items) => {
        if (!active) return
        setKabandas(items)
        setSelectedId((current) => current ?? items.find(({ id }) => id === requestedKabandaId)?.id ?? items[0]?.id ?? null)
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
  const toggleAccount = () => {
    const next = !showAccount
    setShowAccount(next)
    if (!next) return
    setAccountState('loading')
    void getIdentityLocalInventory(user.id)
      .then((value) => {
        setInventory(value)
        setAccountState('idle')
      })
      .catch(() => setAccountState('error'))
  }
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
    <main className="kb-shell">
      <header className="kb-topbar">
        <Brand />
        <button className="kb-identity kb-account-trigger" type="button" aria-expanded={showAccount} aria-controls="kb-account-panel" onClick={toggleAccount} aria-label={`Аккаунт: ${user.displayName ?? user.username ?? user.email ?? 'Участник'}`}>
          <span>{(user.displayName ?? user.username ?? user.email ?? 'У').slice(0, 1).toUpperCase()}</span>
          <div><strong>{user.displayName ?? user.username ?? 'Участник'}</strong><small>{user.username ? `@${user.username}` : user.email}</small></div>
        </button>
      </header>

      {showAccount && (
        <section className="kb-card kb-account-panel" id="kb-account-panel" aria-label="Аккаунт">
          <div><p className="kb-kicker">Аккаунт</p><h2>{user.displayName ?? user.username ?? 'Участник'}</h2><p className="kb-muted">{user.username ? `@${user.username}` : user.email}</p></div>
          {accountState === 'loading' ? <p className="kb-muted" aria-busy="true">Проверяем локальные данные…</p> : null}
          {inventory && inventory.activeRecordings > 0 ? (
            <p className="kb-error" role="alert">Сейчас записывается маршрут. Вернитесь в рейд и остановите запись перед сменой аккаунта.</p>
          ) : inventory && inventory.total > 0 ? (
            <p className="kb-notice" role="status">Локально осталось операций: {inventory.total}. Они сохранятся на устройстве и останутся привязаны только к этому аккаунту.</p>
          ) : inventory ? (
            <p className="kb-muted">Локальных операций, ожидающих синхронизацию, нет.</p>
          ) : null}
          {accountState === 'error' && <p className="kb-error" role="alert">Не удалось проверить данные или завершить выход. Проверьте соединение и повторите.</p>}
          <button className="kb-danger-action" type="button" disabled={accountState === 'loading' || accountState === 'leaving' || (inventory?.activeRecordings ?? 0) > 0} onClick={() => void leaveAccount()}>
            {accountState === 'leaving' ? 'Выходим…' : 'Выйти и сменить аккаунт'}
          </button>
        </section>
      )}

      <section className="kb-heading-row">
        <div><h1>Мои Кабанды</h1><p>Рейды, точки и люди — в одном месте.</p></div>
        {user.identityKind === 'verified' && <button type="button" onClick={() => setShowCreate((value) => !value)}>+ Кабанда</button>}
      </section>

      <InstallGuidance />

      {user.identityKind === 'verified' && showCreate && <CreateKabandaForm onCreated={addKabanda} onCancel={() => setShowCreate(false)} />}
      {error && <p className="kb-error" role="alert">{error}</p>}
      {loading ? <p className="kb-muted" aria-busy="true">Загружаем команды…</p> : null}

      {kabandas.length > 0 && (
        <nav className="kb-tabs" aria-label="Кабанды">
          {kabandas.map((kabanda) => (
            <button key={kabanda.id} type="button" aria-current={kabanda.id === selectedId ? 'page' : undefined} onClick={() => setSelectedId(kabanda.id)}>
              <span>{kabanda.avatar} {kabanda.name}</span><small>{kabanda.memberCount} участников</small>
            </button>
          ))}
        </nav>
      )}

      {!loading && kabandas.length === 0 && !showCreate && (
        <section className="kb-card kb-empty"><h2>Пока без Кабанды</h2><p>Создайте первую команду или откройте приглашение, которое вам прислали.</p><button className="kb-primary" type="button" onClick={() => setShowCreate(true)}>Создать Кабанду</button></section>
      )}

      {selected && !showCreate && <KabandaWorkspace key={selected.id} user={user} kabanda={selected} onLeft={() => removeKabandaLocally(selected.id)} />}
    </main>
  )
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

function KabandaWorkspace({ user, kabanda, onLeft }: { user: User; kabanda: KabandaSummary; onLeft: () => void }) {
  const workspaceRef = useRef<HTMLElement>(null)
  const [members, setMembers] = useState<KabandaMember[]>([])
  const [points, setPoints] = useState<KabandaPoint[]>([])
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null)
  const [requestedView, setRequestedView] = useState<PointPresentation>('map')
  const [providerState, setProviderState] = useState<ProviderState>('checking')
  const [staleAt, setStaleAt] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [membershipAction, setMembershipAction] = useState<string | null>(null)
  const webglAvailable = useMemo(detectWebgl, [])
  const presentation = choosePointPresentation(requestedView, providerState, webglAvailable)
  useKabandaMotion(workspaceRef)

  useEffect(() => {
    let active = true
    listMembers(kabanda.id).then((value) => active && setMembers(value)).catch(() => active && setMessage('Участники временно недоступны.'))
    const collectionId = kabanda.pointsCollectionId
    if (!collectionId) {
      setProviderState('failed')
      setMessage('Организатор ещё не загрузил набор точек.')
      return () => {
        active = false
      }
    }
    listPoints(collectionId, [53.06, 56.74, 53.31, 56.94], 100)
      .then(async ({ points: fresh }) => {
        if (!active) return
        setPoints(fresh)
        setProviderState(webglAvailable ? 'checking' : 'failed')
        setStaleAt(null)
        await savePointProjection(user.id, kabanda.id, collectionId, fresh)
      })
      .catch(async () => {
        const cached = await readPointProjection(user.id, kabanda.id, collectionId)
        if (!active) return
        setProviderState('failed')
        if (cached) {
          setPoints(cached.points)
          setStaleAt(cached.savedAt)
        } else {
          setMessage('Точки недоступны без сети и ещё не сохранены на этом устройстве.')
        }
      })
    return () => {
      active = false
    }
  }, [kabanda, user.id, webglAvailable])

  const selectedPoint = points.find(({ id }) => id === selectedPointId) ?? null
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
  return (
    <section className="kb-workspace" ref={workspaceRef}>
      <aside className="kb-journey-rail" data-journey-rail>
        <div className="kb-summary">
          <div><h2>{kabanda.name}</h2><p>{kabanda.role === 'owner' ? 'Вы организатор' : 'Вы участник'}</p></div>
          <p><strong>{points.filter(({ visitedByMe }) => visitedByMe).length}</strong><span>посещено лично</span></p>
          <p><strong>{points.filter(({ visitedByTeam }) => visitedByTeam).length}</strong><span>посетила команда</span></p>
        </div>
        <p className="kb-route-statement" data-route-statement aria-label="Сначала соберите людей. Затем отправляйтесь к точкам. После сохраните общую историю.">
          {'Сначала соберите людей. Затем отправляйтесь к точкам. После сохраните общую историю.'.split(' ').map((word, index) => <span key={`${word}-${index}`}>{word} </span>)}
        </p>
      </aside>

      <div className="kb-workspace-main">
        {staleAt && <p className="kb-stale" role="status">Офлайн-копия от {new Date(staleAt).toLocaleString('ru-RU')}. Она привязана к вашему аккаунту.</p>}
        {message && <p className="kb-notice" role="status">{message}</p>}

        <div className="kb-command-grid">
          <RaidHomeCard identityId={user.id} kabanda={kabanda} />
          <RaidHistory identityId={user.id} kabandaId={kabanda.id} />
        </div>

        <div className="kb-grid">
        <section className="kb-card kb-points">
          <div className="kb-section-head"><div><h2>Точки маршрута</h2><p>Выберите следующее место на карте или в списке.</p></div><div className="kb-view-switch" aria-label="Вид точек"><button type="button" aria-pressed={presentation === 'map'} disabled={!webglAvailable || providerState === 'failed'} onClick={() => setRequestedView('map')}>Карта</button><button type="button" aria-pressed={presentation === 'list'} onClick={() => setRequestedView('list')}>Список</button></div></div>
          {providerState === 'checking' ? <p className="kb-muted" aria-busy="true">Получаем точки…</p> : null}
          {presentation === 'map' && points.length > 0 ? <PointsMap points={points} selectedId={selectedPointId} onSelect={setSelectedPointId} setProviderState={setProviderState} /> : null}
          {(presentation === 'list' || points.length === 0) && <PointList points={points} selectedId={selectedPointId} onSelect={setSelectedPointId} />}
          {providerState === 'failed' && <p className="kb-muted">Карта недоступна — все точки показаны полноценным списком.</p>}
        </section>

        <aside className="kb-card kb-detail">
          {selectedPoint ? <PointDetail point={selectedPoint} /> : <><h2>Выберите место</h2><p className="kb-muted">Откройте точку на карте или в списке, чтобы увидеть личный и командный статус.</p></>}
        </aside>
        </div>

        <section className="kb-card kb-members-card">
          <div className="kb-section-head"><div><h2>Состав Кабанды</h2><p>Те, с кем вы делите маршрут и общую историю.</p></div><span className="kb-count">{members.length || kabanda.memberCount}</span></div>
          {kabanda.role === 'owner' && <InviteCreator kabandaId={kabanda.id} />}
          {members.length ? <ul className="kb-members">{members.map((member) => <li key={member.id}><span>{member.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{member.displayName}</strong><small>{member.role === 'owner' ? 'Организатор' : 'Участник'}</small></div>{kabanda.role === 'owner' && member.role !== 'owner' && member.id !== user.id ? <button className="kb-member-action" type="button" disabled={membershipAction === member.id} onClick={() => remove(member)}>{membershipAction === member.id ? 'Удаляем…' : 'Удалить'}</button> : null}</li>)}</ul> : <p className="kb-muted">Состав пока не загрузился.</p>}
          {kabanda.role === 'member' && <button className="kb-danger-action" type="button" disabled={membershipAction === 'me'} onClick={leave}>{membershipAction === 'me' ? 'Выходим…' : 'Выйти из Кабанды'}</button>}
        </section>
      </div>
    </section>
  )
}

function InviteCreator({ kabandaId }: { kabandaId: string }) {
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
  if (!link) return <div className="kb-invite-create"><p className="kb-muted">Одноразовая ссылка не добавляет человека сама по себе — он увидит состав и явно подтвердит вход.</p><button type="button" onClick={create} disabled={state === 'creating'}>{state === 'creating' ? 'Создаём ссылку…' : state === 'error' ? 'Повторить создание ссылки' : 'Пригласить участника'}</button></div>
  return <div className="kb-invite-create"><label htmlFor="invite-link">Одноразовое приглашение</label><div className="kb-copy-row"><input id="invite-link" readOnly value={link} /><button type="button" onClick={copy}>Скопировать</button></div>{expiresAt && <small>Действует до {new Date(expiresAt).toLocaleString('ru-RU')}</small>}<button className="kb-text-action" type="button" onClick={reset}>Создать другую ссылку</button></div>
}

function Brand() {
  return <a className="kb-brand" href={appPath('app')} aria-label="КАБАНДА — на главную"><img src={appPath('brand/kabanda-logo-reference.png')} alt="" /><strong>КАБАНДА</strong></a>
}

function PointList({ points, selectedId, onSelect }: { points: KabandaPoint[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (!points.length) return <div className="kb-empty-inline"><strong>Точек пока нет</strong><span>Когда организатор добавит места, они появятся здесь.</span></div>
  return <ul className="kb-point-list">{points.map((point) => <li key={point.id}><button type="button" aria-current={selectedId === point.id ? 'true' : undefined} onClick={() => onSelect(point.id)}><span className={point.visitedByMe ? 'kb-dot visited' : 'kb-dot'} aria-hidden="true" /><span><strong>{point.name}</strong><small>{point.visitedByMe ? 'Вы были здесь' : point.visitedByTeam ? 'Команда уже была' : 'Ещё не посещали'}</small></span><b aria-hidden="true">›</b></button></li>)}</ul>
}

function PointsMap({ points, selectedId, onSelect, setProviderState }: { points: KabandaPoint[]; selectedId: string | null; onSelect: (id: string) => void; setProviderState: Dispatch<SetStateAction<ProviderState>> }) {
  useEffect(() => {
    const container = document.querySelector<HTMLElement>('[data-kabanda-map]')
    if (!container) return
    let destroyed = false
    let teardown: (() => void) | undefined
    void loadMapLibre().then(({ Map, Marker, NavigationControl }) => {
      if (destroyed) return
      const map = new Map({
        container,
        center: [53.2045, 56.8528],
        zoom: 11.3,
        minZoom: 10,
        maxZoom: 18,
        maxBounds: [[53.06, 56.74], [53.31, 56.94]],
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
      map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
      map.once('load', () => !destroyed && setProviderState('ready'))
      map.on('error', () => !destroyed && setProviderState('failed'))
      const markers = points.map((point) => {
        const element = document.createElement('button')
        element.type = 'button'
        element.className = `kb-map-marker${point.visitedByMe ? ' visited' : ''}${selectedId === point.id ? ' selected' : ''}`
        element.setAttribute('aria-label', `${point.name}. ${point.visitedByMe ? 'Посещено лично' : point.visitedByTeam ? 'Посещено командой' : 'Не посещено'}`)
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
  }, [onSelect, points, selectedId, setProviderState])

  return <div className="kb-map" data-kabanda-map role="group" aria-label="Карта точек Ижевска" />
}

function PointDetail({ point }: { point: KabandaPoint }) {
  const verification = point.verificationStatus === 'field_verified' ? 'Проверено на месте' : point.verificationStatus === 'source_checked' ? 'Проверено по источнику' : 'Точка отклонена'
  return <><h2>{point.name}</h2><p className="kb-muted">{verification}</p><dl className="kb-statuses"><div><dt>Личный статус</dt><dd>{point.visitedByMe ? 'Посещено' : 'Не посещено'}</dd></div><div><dt>Статус команды</dt><dd>{point.visitedByTeam ? 'Команда уже была' : 'Пока никто не был'}</dd></div></dl><p className="kb-coordinates">{point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}</p></>
}
