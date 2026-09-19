import http from 'node:http'
import type { Socket } from 'node:net'
import { test as deviceTest, expect } from './persistent-test.js'

type NetworkLink = { setOffline: (offline: boolean) => Promise<void>; deniedRequests: () => number }
type Link = { server: string; offline: boolean; denied: number; disconnect: () => void; close: () => Promise<void> }
const links = new Map<string, Link>()

async function localLink(): Promise<Link> {
  const sockets = new Set<Socket>()
  let link: Link
  const server = http.createServer((request, response) => {
    if (link.offline) { link.denied++; request.socket.destroy(); return }
    let target: URL
    try { target = new URL(request.url ?? '') } catch { response.writeHead(400).end(); return }
    // Test-only forwarder bound to loopback. Never proxy an arbitrary origin,
    // credentials, production host, database or external service.
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' ||
      !['4173', '3000'].includes(target.port) || target.username || target.password) {
      response.writeHead(403).end(); return
    }
    const headers = { ...request.headers, host: target.host }
    delete headers['proxy-authorization']; delete headers['proxy-connection']
    const upstream = http.request({ hostname: target.hostname, port: target.port, method: request.method,
      path: target.pathname + target.search, headers, agent: false }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers)
      incoming.pipe(response)
    })
    upstream.on('socket', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    upstream.on('error', () => response.destroy())
    request.on('error', () => upstream.destroy())
    response.on('close', () => upstream.destroy())
    request.pipe(upstream)
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('connect', (_request, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local test link did not bind')
  link = { server: `http://127.0.0.1:${address.port}`, offline: false, denied: 0,
    disconnect: () => { for (const socket of sockets) socket.destroy() },
    close: async () => { link.disconnect(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
  return link
}

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
  networkLink: async ({ context, contextOptions, browserName }, use) => {
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
  },
})
export { expect }
