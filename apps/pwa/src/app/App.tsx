import { VerifyMagicLinkPage } from '../features/auth/VerifyMagicLinkPage'
import { CapabilityLabPage } from '../features/capability-lab/App'
import { PrototypePage } from '../features/prototype/PrototypePage'
import { RaidsDesignPrototype } from '../features/raids-design/RaidsDesignPrototype'
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
  if (window.location.pathname.endsWith('/prototype')) return <PrototypePage />
  if (window.location.pathname.endsWith('/invite')) return <InvitePage />
  if (window.location.pathname.endsWith('/lab')) return <CapabilityLabPage />
  return <InstallProvider><RecordingRuntimeProvider><AppRoute /><PwaUpdateGate /><AlphaDiagnosticsConsent /></RecordingRuntimeProvider></InstallProvider>
}

function AppRoute() {
  const raidRoute = parseRaidRoute(window.location.search)
  if (raidRoute.kind !== 'home') return <RaidApp route={raidRoute} />
  return <KabandasPage />
}
