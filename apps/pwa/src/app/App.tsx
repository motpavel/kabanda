import { VerifyMagicLinkPage } from '../features/auth/VerifyMagicLinkPage'
import { CapabilityLabPage } from '../features/capability-lab/App'
import { PrototypePage } from '../features/prototype/PrototypePage'
import { InvitePage } from '../features/kabandas/InvitePage'
import { KabandasPage } from '../features/kabandas/KabandasPage'

export function App() {
  if (window.location.pathname.endsWith('/auth/verify')) return <VerifyMagicLinkPage />
  if (window.location.pathname.endsWith('/prototype')) return <PrototypePage />
  if (window.location.pathname.endsWith('/invite')) return <InvitePage />
  if (window.location.pathname.endsWith('/lab')) return <CapabilityLabPage />
  return <KabandasPage />
}
