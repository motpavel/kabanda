import '@fontsource-variable/geist'
import { useEffect, useState, type FormEvent } from 'react'
import { ApiError } from '../../lib/http'
import { acceptInvite, previewInvite } from './api'
import { appPath } from '../../lib/paths'
import { consumeInviteFragment, inviteAcceptanceKey } from './invite'
import type { InvitePreview } from './types'
import './kabandas.css'

let capturedInvite: string | null | undefined

function readInviteOnce(): string | null {
  if (capturedInvite !== undefined) return capturedInvite
  capturedInvite = consumeInviteFragment(window.location, window.history)
  return capturedInvite
}

export function InvitePage() {
  const [rawToken] = useState(readInviteOnce)
  const [invite, setInvite] = useState<InvitePreview | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'accepting' | 'done' | 'invalid'>(
    'loading',
  )
  const [needsAuth, setNeedsAuth] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const credential = rawToken ? { token: rawToken } : { pending: true as const }
    previewInvite(credential)
      .then((result) => {
        capturedInvite = null
        if (!active) return
        if (result.accepted) {
          window.location.replace(appPath(`app?kabanda=${encodeURIComponent(result.kabanda.id)}`))
          return
        }
        setInvite(result)
        setNeedsAuth(result.requiresAuth)
        setState('ready')
      })
      .catch(() => {
        capturedInvite = null
        if (active) setState('invalid')
      })
    return () => {
      active = false
    }
  }, [rawToken])

  const accept = async (credentials?: { username: string; password: string }) => {
    const pendingContinuation = invite?.continuation
    if (!pendingContinuation || state === 'accepting') return
    setState('accepting')
    setAcceptError(null)
    try {
      const idempotencyKey = await inviteAcceptanceKey(pendingContinuation)
      const kabanda = await acceptInvite(pendingContinuation, idempotencyKey, credentials)
      setState('done')
      window.history.replaceState(null, '', appPath('invite'))
      window.location.assign(appPath(`app?kabanda=${encodeURIComponent(kabanda.id)}`))
    } catch (error) {
      if (error instanceof ApiError && error.code === 'REGISTRATION_UNAVAILABLE') {
        setAcceptError('Не удалось использовать этот логин. Выберите другой.')
        setState('ready')
      } else if (error instanceof ApiError && error.status === 401) {
        setNeedsAuth(true)
        setState('ready')
      } else {
        setState('invalid')
      }
    }
  }

  return (
    <main className="kb-shell kb-center">
      <section className="kb-card kb-invite-card" aria-live="polite">
        <a className="kb-brand" href={appPath('app')}><img src={appPath('brand/kabanda-logo-reference.png')} alt="" /><strong>КАБАНДА</strong></a>
        {state === 'loading' && <><p className="kb-kicker">Приглашение</p><h1>Проверяем ссылку…</h1></>}
        {state === 'invalid' && <><p className="kb-kicker">Ссылка не сработала</p><h1>Приглашение недействительно</h1><p className="kb-muted">Оно могло устареть или уже быть использовано. Попросите организатора отправить новое.</p><a className="kb-link-button" href={appPath('app')}>Перейти в приложение</a></>}
        {invite && (state === 'ready' || state === 'accepting' || state === 'done') && <><p className="kb-kicker">Вас зовёт {invite.inviterName}</p><h1>{invite.kabanda.name}</h1><p className="kb-muted">{invite.kabanda.memberCount} участников. После принятия вы увидите точки и историю команды.</p><dl className="kb-invite-meta"><div><dt>Роль</dt><dd>Участник</dd></div><div><dt>Ссылка действует до</dt><dd>{new Date(invite.expiresAt).toLocaleString('ru-RU')}</dd></div></dl>{needsAuth ? <InviteRegistration busy={state === 'accepting'} error={acceptError} onAccept={accept} /> : <button className="kb-primary kb-full" type="button" disabled={state === 'accepting' || state === 'done'} onClick={() => void accept()}>{state === 'accepting' ? 'Присоединяем…' : state === 'done' ? 'Готово' : 'Принять приглашение'}</button>}</>}
      </section>
    </main>
  )
}

function InviteRegistration({ busy, error, onAccept }: {
  busy: boolean
  error: string | null
  onAccept: (credentials: { username: string; password: string }) => Promise<void>
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    await onAccept({ username, password })
  }
  return <form onSubmit={submit}><p className="kb-muted">Придумайте логин и пароль. Они понадобятся для следующего входа — почта не нужна.</p><label htmlFor="invite-username">Логин</label><input id="invite-username" autoComplete="username" required minLength={3} maxLength={32} pattern="[A-Za-zА-Яа-яЁё0-9._-]+" value={username} onChange={(event) => setUsername(event.target.value)} /><label htmlFor="invite-password">Пароль</label><input id="invite-password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /><button className="kb-primary kb-full" type="submit" disabled={busy}>{busy ? 'Присоединяем…' : 'Вступить в команду'}</button>{error && <p className="kb-error" role="alert">{error}</p>}</form>
}
