import { VerifyMagicLinkPage } from '../features/auth/VerifyMagicLinkPage'
import { CapabilityLabPage } from '../features/capability-lab/App'
import { PrototypePage } from '../features/prototype/PrototypePage'
import { RaidsDesignPrototype } from '../features/raids-design/RaidsDesignPrototype'
import { RouteTrackingPrototype } from '../features/route-tracking-prototype/RouteTrackingPrototype'
import { InvitePage } from '../features/kabandas/InvitePage'
import { KabandasPage } from '../features/kabandas/KabandasPage'
import { RaidApp } from '../features/raids/RaidApp'
import { PwaUpdateGate } from '../features/raids/PwaUpdateGate'
import { RecordingRuntimeProvider } from '../features/raids/recording/runtime'
import { parseRaidRoute } from '../features/raids/routing'
import { AlphaDiagnosticsConsent } from './AlphaDiagnosticsConsent'
import { InstallProvider } from '../features/install/InstallGuidance'

export function App() {
  if (window.location.pathname.endsWith('/auth/verify')) return <VerifyMagicLinkPage />
  if (window.location.pathname.endsWith('/prototype/raids')) return <RaidsDesignPrototype />
  if (window.location.pathname.endsWith('/prototype/route-tracking')) return <RouteTrackingPrototype />
  if (window.location.pathname.endsWith('/prototype')) return <PrototypePage />
  if (window.location.pathname.endsWith('/invite')) return <InvitePage />
  if (window.location.pathname.endsWith('/lab')) return <CapabilityLabPage />
  return <InstallProvider><RecordingRuntimeProvider><AppRoute /><PwaUpdateGate /><AlphaDiagnosticsConsent /></RecordingRuntimeProvider></InstallProvider>
}

function AppRoute() {
  const search = useSyncExternalStore(subscribeRoute, () => window.location.search, () => '')
  useEffect(() => {
    const followLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return
      const url = new URL(anchor.href)
      if (!isInternalAppLink(url, window.location.origin, appPath('app'))) return
      event.preventDefault()
      if (url.href !== window.location.href) navigateApp(`${url.pathname}${url.search}`)
    }
    document.addEventListener('click', followLink)
    return () => document.removeEventListener('click', followLink)
  }, [])
  const raidRoute = parseRaidRoute(search)
  if (raidRoute.kind !== 'home') return <RaidApp route={raidRoute} />
  return <KabandasPage />
}

function subscribeRoute(listener: () => void) {
  window.addEventListener('popstate', listener)
  return () => window.removeEventListener('popstate', listener)
}
import { useEffect, useSyncExternalStore } from 'react'
import { appPath } from '../lib/paths'
import { isInternalAppLink, navigateApp } from './transitions'
