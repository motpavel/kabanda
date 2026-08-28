import { VerifyMagicLinkPage } from '../features/auth/VerifyMagicLinkPage'
import { CapabilityLabPage } from '../features/capability-lab/App'

export function App() {
  if (window.location.pathname.endsWith('/auth/verify')) return <VerifyMagicLinkPage />
  return <CapabilityLabPage />
}
