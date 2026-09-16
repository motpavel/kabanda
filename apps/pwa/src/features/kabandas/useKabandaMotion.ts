import { useEffect, type RefObject } from 'react'

/** Desktop decoration must not delay the phone's first render or GPS runtime. */
export function useKabandaMotion(scope: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const media = window.matchMedia('(min-width: 621px) and (prefers-reduced-motion: no-preference)')
    let cancelled = false
    let revert: (() => void) | undefined
    let generation = 0
    const update = () => {
      const started = ++generation
      revert?.()
      revert = undefined
      const statement = scope.current?.querySelector<HTMLElement>('[data-route-statement]')
      if (!media.matches || !statement) return
      void import('./kabanda-motion').then(({ animateStatement }) => {
        if (!cancelled && started === generation && media.matches) revert = animateStatement(statement)
      }).catch(() => { /* Decorative animation is optional, including offline. */ })
    }
    update()
    media.addEventListener('change', update)
    return () => { cancelled = true; revert?.(); media.removeEventListener('change', update) }
  }, [scope])
}
