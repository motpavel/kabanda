import { test as deviceTest, expect } from './persistent-test.js'
import { localLink } from './offline-link.mjs'
import { savedPhotoProbe } from './saved-photo-probe.js'
import './photo-reload-cases.js'

type NetworkLink = { setOffline: (offline: boolean) => Promise<void>; deniedRequests: () => number }
type Link = { server: string; offline: boolean; denied: number; disconnect: () => void; close: () => Promise<void> }
const links = new Map<string, Link>()

/** WebKit's global offline emulation also made native FileReader/arrayBuffer
 * unreadable in CI, for both path and in-memory chooser payloads. Disconnect
 * actual HTTP sockets instead (including service-worker requests). The only
 * emulated DOM property is link availability, like the native offline fixture;
 * files, decoder, IndexedDB, SW caches and API responses remain unmodified. */
export const test = deviceTest.extend<{ networkLink: NetworkLink }>({
  contextOptions: async ({ contextOptions, browserName }, use) => {
    if (browserName !== 'webkit') { await use(contextOptions); return }
    const link = await localLink(); links.set(link.server, link)
    try { await use({ ...contextOptions, proxy: { server: link.server, bypass: '' } }) }
    finally { links.delete(link.server); await link.close() }
  },
  networkLink: async ({ context, contextOptions, browserName }, use, info) => {
    if (browserName !== 'webkit') {
      await use({ setOffline: value => context.setOffline(value), deniedRequests: () => -1 }); return
    }
    const link = links.get(contextOptions.proxy?.server ?? '')
    if (!link) throw new Error('WebKit offline test link missing')
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => {
        try { return sessionStorage.getItem('kabanda-test-link-offline') !== 'true' } catch { return true }
      } })
    })
    try {
      await use({ deniedRequests: () => link.denied, setOffline: async offline => {
        link.offline = offline
        if (offline) link.disconnect()
        for (const page of context.pages()) {
          if (!page.url().startsWith('http://127.0.0.1:4173/')) continue
          await page.evaluate(value => {
            sessionStorage.setItem('kabanda-test-link-offline', String(value))
            window.dispatchEvent(new Event(value ? 'offline' : 'online'))
          }, offline)
        }
      } })
    } finally {
      if (info.status !== info.expectedStatus) for (const page of context.pages()) {
        if (page.url().startsWith('http://127.0.0.1:4173/')) await savedPhotoProbe(page, info)
      }
    }
  },
})
export { expect }
