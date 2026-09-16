import { Component, lazy, Suspense, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { VerifyMagicLinkPage } from '../features/auth/VerifyMagicLinkPage'
import { InvitePage } from '../features/kabandas/InvitePage'
import { KabandasPage } from '../features/kabandas/KabandasPage'
import { RaidApp } from '../features/raids/RaidApp'
import { PwaUpdateGate } from '../features/raids/PwaUpdateGate'
import { RecordingRuntimeProvider } from '../features/raids/recording/runtime'
import { parseRaidRoute } from '../features/raids/routing'
import { AlphaDiagnosticsConsent } from './AlphaDiagnosticsConsent'
import { InstallProvider } from '../features/install/InstallGuidance'
import { PortraitMode } from './PortraitMode'
import { RetainedScreen } from './RetainedScreen'
import { appPath } from '../lib/paths'
import { isInternalAppLink, navigateApp } from './transitions'

const CapabilityLabPage = lazy(() => import('../features/capability-lab/App').then(module => ({ default: module.CapabilityLabPage })))
const GpsExperimentPage = lazy(() => import('../features/capability-lab/GpsExperimentPage').then(module => ({ default: module.GpsExperimentPage })))
const PrototypePage = lazy(() => import('../features/prototype/PrototypePage').then(module => ({ default: module.PrototypePage })))
const RaidsDesignPrototype = lazy(() => import('../features/raids-design/RaidsDesignPrototype').then(module => ({ default: module.RaidsDesignPrototype })))
const RouteTrackingPrototype = lazy(() => import('../features/route-tracking-prototype/RouteTrackingPrototype').then(module => ({ default: module.RouteTrackingPrototype })))

export function App() {
  if (window.location.pathname.endsWith('/auth/verify')) return <VerifyMagicLinkPage />
  if (window.location.pathname.endsWith('/prototype/raids')) return <OptionalScreen><RaidsDesignPrototype /></OptionalScreen>
  if (window.location.pathname.endsWith('/prototype/route-tracking')) return <OptionalScreen><RouteTrackingPrototype /></OptionalScreen>
  if (window.location.pathname.endsWith('/prototype')) return <OptionalScreen><PrototypePage /></OptionalScreen>
  if (window.location.pathname.endsWith('/invite')) return <InvitePage />
  if (window.location.pathname.endsWith('/lab/legacy')) return <OptionalScreen><CapabilityLabPage /></OptionalScreen>
  if (/\/lab(?:\/index\.html|\/)?$/.test(window.location.pathname)) return <OptionalScreen><GpsExperimentPage /></OptionalScreen>
  return <InstallProvider><RecordingRuntimeProvider><AppRoute /><PortraitMode /><PwaUpdateGate /><AlphaDiagnosticsConsent /></RecordingRuntimeProvider></InstallProvider>
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
  return <>
    <RetainedScreen active={raidRoute.kind === 'home'}><KabandasPage active={raidRoute.kind === 'home'} /></RetainedScreen>
    {raidRoute.kind !== 'home' && <RaidApp route={raidRoute} />}
  </>
}

function subscribeRoute(listener: () => void) {
  window.addEventListener('popstate', listener)
  return () => window.removeEventListener('popstate', listener)
}

/** Optional tools can fail to load without taking the production/recording tree down. */
class OptionalScreen extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <main className="kb-shell"><section className="kb-card" role="alert"><h1>Экран не загрузился</h1><p>Проверьте подключение и попробуйте ещё раз.</p><button type="button" onClick={() => window.location.reload()}>Повторить загрузку</button><p><a href={appPath('app')}>На главную</a></p></section></main>
    return <Suspense fallback={<main className="kb-shell" aria-busy="true"><p role="status">Загружаем экран…</p></main>}>{this.props.children}</Suspense>
  }
}
