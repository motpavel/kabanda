import { useEffect, useRef, useState } from 'react'
import { RiderLoader } from '../../app/RiderLoader'
import type { RaidProjection } from '../raids/types'
import { CompletedRaidRoute } from './CompletedRaidRoute'
import { completeReadyRaid } from './complete'
import { drainFinalizingServerTail } from './local'

export function FinalizationPanel(props: {
  identityId: string
  raid: RaidProjection
  staleProjection: boolean
  onCanonicalRefresh: () => Promise<unknown>
  onApplyRaid: (raid: RaidProjection) => Promise<unknown>
}) {
  const latest = useRef(props)
  latest.current = props
  const inFlight = useRef(false)
  const retry = useRef<() => void>(() => undefined)
  const [message, setMessage] = useState<string | null>(null)
  const [online, setOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    let active = true
    const update = async () => {
      if (!active || inFlight.current || document.visibilityState !== 'visible') return
      setOnline(navigator.onLine)
      if (!navigator.onLine) return
      inFlight.current = true
      try {
        const current = latest.current
        if (current.staleProjection) { await current.onCanonicalRefresh(); return }
        await drainFinalizingServerTail({ identityId: current.identityId, raidId: current.raid.id, online: true }).catch(() => undefined)
        if (!active) return
        const next = await completeReadyRaid(current.identityId, current.raid)
        if (!active) return
        if (next.state === 'completed') await current.onApplyRaid(next)
        else await current.onCanonicalRefresh()
        if (active) setMessage(null)
      } catch {
        if (active) {
          setMessage('Не удалось обновить итог. Повторим автоматически, когда появится связь.')
          await latest.current.onCanonicalRefresh().catch(() => undefined)
        }
      } finally { inFlight.current = false }
    }
    const resume = () => { setOnline(navigator.onLine); void update() }
    retry.current = resume
    resume()
    const timer = window.setInterval(resume, 3000)
    window.addEventListener('online', resume)
    window.addEventListener('offline', resume)
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('online', resume)
      window.removeEventListener('offline', resume)
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [props.identityId, props.raid.id])

  return <section className="result-shell">
    <header className="result-completion-details"><h1>Итоги рейда</h1><h2>{props.raid.title}</h2></header>
    <CompletedRaidRoute identityId={props.identityId} raid={props.raid} />
    <section className="kb-card result-saving" aria-label="Сохранение результатов">
      <RiderLoader label="Сохраняем результаты" />
      <p role="status">{!online ? 'Нет связи. Итоги появятся после подключения к интернету.' : message ?? 'Сохраняем результаты. Карта и статистика обновятся автоматически.'}</p>
      {message && online && <button type="button" onClick={() => retry.current()}>Повторить</button>}
    </section>
  </section>
}
