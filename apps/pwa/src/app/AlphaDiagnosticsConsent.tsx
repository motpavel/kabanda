import { useEffect, useState } from 'react'
import {
  alphaDiagnosticsConsentGranted,
  setAlphaDiagnosticsConsent,
} from '../lib/diagnostics'
import { getActiveIdentityId, IDENTITY_CHANGED_EVENT } from '../features/offline/ledger'

export function AlphaDiagnosticsConsent() {
  const [identityId, setIdentityId] = useState<string | null>(null)
  const [consented, setConsented] = useState(false)

  useEffect(() => {
    if (typeof __ALPHA_DIAGNOSTICS__ === 'undefined' || !__ALPHA_DIAGNOSTICS__) return
    let active = true
    const applyIdentity = (nextIdentityId: string | null) => {
      if (!active) return
      setIdentityId(nextIdentityId)
      setConsented(nextIdentityId ? alphaDiagnosticsConsentGranted(nextIdentityId) : false)
    }
    void getActiveIdentityId().then(applyIdentity)
    const onIdentityChange = (event: Event) => {
      const nextIdentityId = (event as CustomEvent<{ userId: string | null }>).detail?.userId ?? null
      applyIdentity(nextIdentityId)
    }
    window.addEventListener(IDENTITY_CHANGED_EVENT, onIdentityChange)
    return () => {
      active = false
      window.removeEventListener(IDENTITY_CHANGED_EVENT, onIdentityChange)
    }
  }, [])

  if (typeof __ALPHA_DIAGNOSTICS__ === 'undefined' || !__ALPHA_DIAGNOSTICS__ || !identityId) return null

  return (
    <aside className="alpha-diagnostics-consent" aria-label="Согласие на диагностику закрытой альфы">
      <div>
        <strong>Диагностика закрытой альфы</strong>
        <span>Только тип сбоя и короткие технические коды — без координат, фото и свободного текста.</span>
      </div>
      <label>
        <input
          type="checkbox"
          checked={consented}
          onChange={(event) => {
            const granted = setAlphaDiagnosticsConsent(identityId, event.target.checked)
            setConsented(granted)
          }}
        />
        Разрешить отправку; галочку можно снять в любой момент
      </label>
    </aside>
  )
}
