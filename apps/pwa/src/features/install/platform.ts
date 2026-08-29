export type InstallEnvironment = 'installed' | 'ios' | 'browser'

export interface InstallPlatformSignals {
  standaloneDisplay: boolean
  navigatorStandalone: boolean
  userAgent: string
  platform: string
  maxTouchPoints: number
}

export function isIosLikeDevice(signals: Pick<InstallPlatformSignals, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  return /iPad|iPhone|iPod/i.test(signals.userAgent) ||
    (signals.platform === 'MacIntel' && signals.maxTouchPoints > 1)
}

export function resolveInstallEnvironment(signals: InstallPlatformSignals): InstallEnvironment {
  if (signals.standaloneDisplay || signals.navigatorStandalone) return 'installed'
  return isIosLikeDevice(signals) ? 'ios' : 'browser'
}
