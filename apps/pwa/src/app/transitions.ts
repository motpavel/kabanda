import { flushSync } from 'react-dom'

// Keep browser back/forward and real URLs. No cache of protected screens or GPS state.
export function transitionScreen(update: () => void, direction: 'forward' | 'back' = 'forward') {
  const commit = () => flushSync(update)
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !document.startViewTransition) {
    commit()
    return
  }
  document.documentElement.dataset.transitionDirection = direction
  const transition = document.startViewTransition(commit)
  void transition.finished.catch(() => undefined)
}

export function navigateApp(href: string) {
  transitionScreen(() => {
    window.history.pushState(null, '', href)
    window.dispatchEvent(new PopStateEvent('popstate'))
    window.scrollTo({ top: 0, behavior: 'instant' })
  })
}

export function isInternalAppLink(url: URL, origin: string, appPathname: string): boolean {
  return url.origin === origin && url.pathname === appPathname && !url.hash
}
