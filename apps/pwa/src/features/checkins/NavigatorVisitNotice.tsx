import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RaidMapPoint } from '../raids/types'
import { NavigatorNoticeState } from './navigator-notice-state'
import './participant-visit.css'
import './navigator-visit-notice.css'

/** Observes confirmed snapshots; neither enqueue nor a generic onSaved callback
 * can celebrate. Mounted beside the map so sheet lifecycle cannot lose a receipt. */
export function NavigatorVisitNotice({ identityId, raidId, points, enabled, visible, onOpen }: {
  identityId: string; raidId: string; points: readonly RaidMapPoint[] | undefined
  enabled: boolean; visible: boolean; onOpen: (point: RaidMapPoint) => void
}) {
  const state = useRef<{ key: string; tracker: NavigatorNoticeState } | null>(null)
  const [notice, setNotice] = useState<{ point: RaidMapPoint; scope: string } | null>(null)
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible')
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const element = useRef<HTMLElement>(null)
  const scope = JSON.stringify([identityId, raidId])
  useEffect(() => {
    if (state.current?.key !== scope) {
      let storage: Storage | undefined
      try { storage = window.sessionStorage } catch { /* In-memory presentation is sufficient. */ }
      state.current = { key: scope, tracker: new NavigatorNoticeState(identityId, raidId, storage) }
      setNotice(null)
    }
    if (!enabled) { state.current.tracker.suspend(); setNotice(null); return }
    const point = state.current.tracker.observe(points)
    if (point) setNotice({ point, scope })
  }, [identityId, raidId, scope, points, enabled])
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  const shown = notice?.scope === scope && enabled && visible && pageVisible ? notice : null
  // A recovery/error notice is allowed at the same time. Reserve the actual
  // toast height so neither its text nor the map controls cover that action.
  // Only layout changes trigger this observer, never the map animation frames.
  useLayoutEffect(() => {
    const node = element.current
    const root = node?.closest<HTMLElement>('.raid-active-map')
    if (!shown || !node || !root) return
    const measure = () => root.style.setProperty('--navigator-toast-height', `${node.offsetHeight}px`)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => { observer.disconnect(); root.style.removeProperty('--navigator-toast-height') }
  }, [shown])
  useEffect(() => { if (!shown) { setHovered(false); setFocused(false) } }, [shown])
  useEffect(() => {
    if (!shown || hovered || focused) return
    const timer = setTimeout(() => setNotice(current => current === shown ? null : current), 8000)
    return () => clearTimeout(timer)
  }, [shown, hovered, focused])
  return <>
    <span className="visit-toast-announcement" role="status" aria-atomic="true">{shown ? `Точка отмечена! ${shown.point.name}. Отличная остановка!` : ''}</span>
    {shown && <section ref={element} key={shown.point.myLastVisitAttemptId} className="visit-toast navigator-visit-toast" aria-label="Успешная отметка навигатора"
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)} onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
      }}>
      <button className="visit-toast__open" type="button" onClick={() => { onOpen(shown.point); setNotice(null) }}>
        <span className="visit-toast__icon" aria-hidden="true">✓</span>
        <span><strong>Точка отмечена!</strong><small>{shown.point.name} · Отличная остановка!</small></span>
      </button>
      <button className="visit-toast__close" type="button" aria-label="Закрыть подтверждение навигатора" onClick={() => setNotice(null)}>×</button>
    </section>}
  </>
}
