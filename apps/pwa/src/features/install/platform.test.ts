import { describe, expect, it } from 'vitest'
import { isIosLikeDevice, resolveInstallEnvironment } from './platform'

const browserSignals = {
  standaloneDisplay: false,
  navigatorStandalone: false,
  userAgent: 'Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36',
  platform: 'Linux x86_64',
  maxTouchPoints: 0,
}

describe('production PWA install platform', () => {
  it('treats display-mode and iOS navigator standalone as installed', () => {
    expect(resolveInstallEnvironment({ ...browserSignals, standaloneDisplay: true })).toBe('installed')
    expect(resolveInstallEnvironment({ ...browserSignals, navigatorStandalone: true })).toBe('installed')
  })

  it('recognizes iPhone, iPad and touch-capable iPadOS desktop user agents', () => {
    expect(isIosLikeDevice({ ...browserSignals, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)' })).toBe(true)
    expect(isIosLikeDevice({ ...browserSignals, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true)
    expect(resolveInstallEnvironment({ ...browserSignals, platform: 'MacIntel', maxTouchPoints: 5 })).toBe('ios')
  })

  it('keeps Chromium and other browsers on the prompt-capable browser path', () => {
    expect(resolveInstallEnvironment(browserSignals)).toBe('browser')
  })
})
