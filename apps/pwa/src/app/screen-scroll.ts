import { useLayoutEffect, useRef } from 'react'
import { subscribeBeforeAppNavigation } from './navigation-history'

type ScrollPosition = { x: number; y: number }
const origin: ScrollPosition = { x: 0, y: 0 }

/** Ephemeral UI state, never a permission or an offline operation. The owner
 * is the identity-keyed authenticated shell; logout/unmount discards it. */
export class ScreenScrollMemory {
  private positions = new Map<string, ScrollPosition>()
  read(key: string): ScrollPosition { return { ...(this.positions.get(key) ?? origin) } }
  save(key: string, position: ScrollPosition) {
    if (![position.x, position.y].every(Number.isFinite)) return
    this.positions.delete(key)
    this.positions.set(key, { x: Math.max(0, position.x), y: Math.max(0, position.y) })
    if (this.positions.size > 64) this.positions.delete(this.positions.keys().next().value!)
  }
}

/** Restore on a screen change, not on data polls. Pending layout restoration
 * is bounded and yields immediately to the user's own scrolling/navigation. */
export function useScreenScroll(key: string, active: boolean) {
  const memory = useRef(new ScreenScrollMemory())
  useLayoutEffect(() => {
    if (!active) return
    const target = memory.current.read(key)
    let latest = target
    let restoring = true
    let timer: number | undefined
    let observer: ResizeObserver | undefined
    const finish = () => {
      restoring = false
      observer?.disconnect()
      if (timer !== undefined) window.clearTimeout(timer)
    }
    const save = () => {
      if (restoring) return
      latest = { x: window.scrollX, y: window.scrollY }
      memory.current.save(key, latest)
    }
    const restore = () => {
      if (!restoring) return
      window.scrollTo({ left: target.x, top: target.y, behavior: 'instant' })
      if (Math.abs(window.scrollY - target.y) <= 1 && Math.abs(window.scrollX - target.x) <= 1) finish()
    }
    const interrupt = () => { finish(); save() }
    const keyDown = (event: KeyboardEvent) => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ', 'Tab'].includes(event.key)) interrupt()
    }
    // Capture BEFORE the old screen is hidden; reading scrollY in a React
    // cleanup alone can observe the new (shorter) page's clamped position.
    const unsubscribe = subscribeBeforeAppNavigation(() => {
      if (!restoring) save()
      finish()
    })
    window.addEventListener('scroll', save, { passive: true })
    window.addEventListener('wheel', interrupt, { passive: true })
    window.addEventListener('touchstart', interrupt, { passive: true })
    window.addEventListener('pointerdown', interrupt, { passive: true })
    window.addEventListener('keydown', keyDown)
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(restore)
      observer.observe(document.body)
    }
    timer = window.setTimeout(() => { finish(); save() }, 2_500)
    restore()
    return () => {
      finish()
      memory.current.save(key, latest)
      unsubscribe()
      window.removeEventListener('scroll', save)
      window.removeEventListener('wheel', interrupt)
      window.removeEventListener('touchstart', interrupt)
      window.removeEventListener('pointerdown', interrupt)
      window.removeEventListener('keydown', keyDown)
    }
  }, [key, active])
}
