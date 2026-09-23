import { Component, lazy, Suspense, useEffect, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react'
import { VerifyMagicLinkPage } from '../features/auth/VerifyMagicLinkPage'
import { InvitePage } from '../features/kabandas/InvitePage'
import { KabandasPage } from '../features/kabandas/KabandasPage'
import { RaidApp } from '../features/raids/RaidApp'
import { PwaUpdateGate } from '../features/raids/PwaUpdateGate'
import { FieldSyncOwner } from '../features/raids/FieldSyncOwner'
import { RecordingRuntimeProvider } from '../features/raids/recording/runtime'
import { parseRaidRoute } from '../features/raids/routing'
import { RiderLoader } from './RiderLoader'
import { InstallProvider } from '../features/install/InstallGuidance'
import { PortraitMode } from './PortraitMode'
import { RetainedScreen } from './RetainedScreen'
import { appPath } from '../lib/paths'
import { isInternalAppLink, navigateApp } from './transitions'
import { readAppSearch, subscribeAppLocation } from './navigation-history'
import { OfflineCityMap } from '../features/offline-map/OfflineCityMap'
import './smooth-ui.css'

const CapabilityLabPage = lazy(() => import('../features/capability-lab/App').then(module => ({ default: module.CapabilityLabPage })))
const GpsExperimentPage = lazy(() => import('../features/capability-lab/GpsExperimentPage').then(module => ({ default: module.GpsExperimentPage })))
const PrototypePage = lazy(() => import('../features/prototype/PrototypePage').then(module => ({ default: module.PrototypePage })))
const RaidsDesignPrototype = lazy(() => import('../features/raids-design/RaidsDesignPrototype').then(module => ({ default: module.RaidsDesignPrototype })))
const RouteTrackingPrototype = lazy(() => import('../features/route-tracking-prototype/RouteTrackingPrototype').then(module => ({ default: module.RouteTrackingPrototype })))

export function App() {
  const search = useSyncExternalStore(subscribeAppLocation, readAppSearch, () => '')
  if (window.location.pathname.endsWith('/auth/verify')) return <VerifyMagicLinkPage />
  if (window.location.pathname.endsWith('/prototype/raids')) return <OptionalScreen><RaidsDesignPrototype /></OptionalScreen>
  if (window.location.pathname.endsWith('/prototype/route-tracking')) return <OptionalScreen><RouteTrackingPrototype /></OptionalScreen>
  if (window.location.pathname.endsWith('/prototype')) return <OptionalScreen><PrototypePage /></OptionalScreen>
  if (window.location.pathname.endsWith('/invite')) return <InvitePage />
  if (window.location.pathname.endsWith('/lab/legacy')) return <OptionalScreen><CapabilityLabPage /></OptionalScreen>
  if (/\/lab(?:\/index\.html|\/)?$/.test(window.location.pathname)) return <OptionalScreen><GpsExperimentPage /></OptionalScreen>
  // Public basemap only: an offline launch must not need a session check or
  // mount the recording/field-sync tree to render already downloaded streets.
  if (new URLSearchParams(search).get('offlineMap') === '1') return <><OfflineCityMap /><PortraitMode /></>
  return <InstallProvider><RecordingRuntimeProvider><FieldSyncOwner /><AppRoute /><PortraitMode /><PwaUpdateGate /></RecordingRuntimeProvider></InstallProvider>
}

function AppRoute() {
  const search = useSyncExternalStore(subscribeAppLocation, readAppSearch, () => '')
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
  useLayoutEffect(() => {
    // Tab pages restore their own identity/team-scoped position. New detail
    // and creation screens start at the top, including browser Back/Forward.
    if (parseRaidRoute(search).kind !== 'home') window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [search])
  return <>
    <RetainedScreen active={raidRoute.kind === 'home'}><KabandasPage active={raidRoute.kind === 'home'} /></RetainedScreen>
    {raidRoute.kind !== 'home' && <RaidApp route={raidRoute} />}
  </>
}

/** Optional tools can fail to load without taking the production/recording tree down. */
class OptionalScreen extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <main className="kb-shell"><section className="kb-card" role="alert"><h1>Экран не загрузился</h1><p>Проверьте подключение и попробуйте ещё раз.</p><button type="button" onClick={() => window.location.reload()}>Повторить загрузку</button><p><a href={appPath('app')}>На главную</a></p></section></main>
    return <Suspense fallback={<main className="kb-shell"><RiderLoader label="Загружаем экран" /></main>}>{this.props.children}</Suspense>
  }
}
