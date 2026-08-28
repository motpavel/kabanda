import { VerifyMagicLinkPage } from '../features/auth/VerifyMagicLinkPage'
import { CapabilityLabPage } from '../features/capability-lab/App'
import { PrototypePage } from '../features/prototype/PrototypePage'
import { InvitePage } from '../features/kabandas/InvitePage'
import { KabandasPage } from '../features/kabandas/KabandasPage'
import { RaidApp } from '../features/raids/RaidApp'
import { parseRaidRoute } from '../features/raids/routing'

export function App() {
  if (window.location.pathname.endsWith('/auth/verify')) return <VerifyMagicLinkPage />
  if (window.location.pathname.endsWith('/prototype')) return <PrototypePage />
  if (window.location.pathname.endsWith('/invite')) return <InvitePage />
  if (window.location.pathname.endsWith('/lab')) return <CapabilityLabPage />
  const raidRoute = parseRaidRoute(window.location.search)
  if (raidRoute.kind !== 'home') return <RaidApp route={raidRoute} />
  return <KabandasPage />
}
