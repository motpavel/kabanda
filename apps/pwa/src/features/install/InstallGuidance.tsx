import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { resolveInstallEnvironment, type InstallEnvironment, type InstallPlatformSignals } from './platform'

interface InstallContextValue {
  environment: InstallEnvironment
  promptAvailable: boolean
  installing: boolean
  message: string | null
  install: () => Promise<void>
}

const InstallContext = createContext<InstallContextValue | null>(null)

function platformSignals(): InstallPlatformSignals {
  const iosNavigator = navigator as Navigator & { standalone?: boolean }
  return {
    standaloneDisplay: window.matchMedia('(display-mode: standalone)').matches,
    navigatorStandalone: iosNavigator.standalone === true,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  }
}

export function InstallProvider({ children }: { children: ReactNode }) {
  const [environment, setEnvironment] = useState<InstallEnvironment>(() => resolveInstallEnvironment(platformSignals()))
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [installing, setInstalling] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    const displayMode = window.matchMedia('(display-mode: standalone)')
    const refreshEnvironment = () => setEnvironment(resolveInstallEnvironment(platformSignals()))
    const capturePrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as BeforeInstallPromptEvent)
      setMessage(null)
    }
    const markInstalled = () => {
      setInstallPrompt(null)
      setEnvironment('installed')
      setMessage('КАБАНДА установлена на устройство.')
    }

    displayMode.addEventListener?.('change', refreshEnvironment)
    window.addEventListener('beforeinstallprompt', capturePrompt)
    window.addEventListener('appinstalled', markInstalled)
    return () => {
      displayMode.removeEventListener?.('change', refreshEnvironment)
      window.removeEventListener('beforeinstallprompt', capturePrompt)
      window.removeEventListener('appinstalled', markInstalled)
    }
  }, [])

  const install = useCallback(async () => {
    if (!installPrompt || installing) return
    setInstalling(true)
    setMessage(null)
    try {
      await installPrompt.prompt()
      const choice = await installPrompt.userChoice
      setInstallPrompt(null)
      if (choice.outcome === 'dismissed') {
        setMessage('Установка отменена. Её можно снова открыть из меню браузера.')
      }
    } catch {
      setMessage('Не удалось открыть установку. Используйте пункт установки в меню браузера.')
    } finally {
      setInstalling(false)
    }
  }, [installPrompt, installing])

  const value = useMemo<InstallContextValue>(() => ({
    environment,
    promptAvailable: Boolean(installPrompt),
    installing,
    message,
    install,
  }), [environment, installPrompt, installing, message, install])

  return <InstallContext.Provider value={value}>{children}</InstallContext.Provider>
}

export function InstallGuidance() {
  const installState = useContext(InstallContext)
  if (!installState || installState.environment === 'installed') return null

  return (
    <section className="kb-card kb-install-guidance" aria-labelledby="kb-install-title">
      <div>
        <p className="kb-kicker">Приложение на телефоне</p>
        <h2 id="kb-install-title">Установите КАБАНДУ перед рейдом</h2>
        {installState.environment === 'ios' ? (
          <p className="kb-muted">В Safari нажмите «Поделиться», затем «На экран Домой» и подтвердите добавление.</p>
        ) : installState.promptAvailable ? (
          <p className="kb-muted">Установленная версия открывается отдельно от браузера и готова к проверке маршрута.</p>
        ) : (
          <p className="kb-muted">Откройте меню браузера и выберите «Установить приложение» или «Добавить на главный экран».</p>
        )}
      </div>
      {installState.environment === 'browser' && installState.promptAvailable && (
        <button className="kb-primary" type="button" disabled={installState.installing} onClick={() => void installState.install()}>
          {installState.installing ? 'Открываем…' : 'Установить КАБАНДУ'}
        </button>
      )}
      {installState.message && <p className="kb-notice" role="status">{installState.message}</p>}
    </section>
  )
}
