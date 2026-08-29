import { useState } from 'react'
import { verifyMagicLink } from './api'

let tokenFromFragment: string | null | undefined

function readTokenOnce(): string | null {
  if (tokenFromFragment !== undefined) return tokenFromFragment
  tokenFromFragment = new URLSearchParams(window.location.hash.slice(1)).get('token')
  if (window.location.hash) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  }
  return tokenFromFragment
}

export function VerifyMagicLinkPage() {
  const [token] = useState(readTokenOnce)
  const [status, setStatus] = useState<'ready' | 'submitting' | 'error'>(
    token ? 'ready' : 'error',
  )

  const confirm = async () => {
    if (!token || status === 'submitting') return
    setStatus('submitting')
    try {
      const returnTo = await verifyMagicLink(token)
      window.location.replace(returnTo)
    } catch {
      setStatus('error')
    }
  }

  return (
    <main>
      <header className="hero">
        <p className="eyebrow">КАБАНДА</p>
        <h1>Подтвердите вход</h1>
        <p>Ссылка сама ничего не активирует — вход произойдёт только после нажатия кнопки.</p>
      </header>
      <section className="panel" aria-live="polite">
        {status === 'error' ? (
          <p>Ссылка недействительна, уже использована или устарела. Запросите новую ссылку.</p>
        ) : (
          <div className="actions">
            <button
              className="primary"
              type="button"
              onClick={confirm}
              disabled={!token || status === 'submitting'}
            >
              {status === 'submitting' ? 'Входим…' : 'Войти в КАБАНДУ'}
            </button>
          </div>
        )}
      </section>
    </main>
  )
}
