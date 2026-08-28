import { VerifyMagicLinkPage } from '../features/auth/VerifyMagicLinkPage'
import { CapabilityLabPage } from '../features/capability-lab/App'
import { PrototypePage } from '../features/prototype/PrototypePage'

export function App() {
  if (window.location.pathname.endsWith('/auth/verify')) return <VerifyMagicLinkPage />
  if (window.location.pathname.endsWith('/prototype')) return <PrototypePage />
  return <CapabilityLabPage />
}
