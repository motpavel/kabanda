// Isolated service-worker harness: actual cache code, deterministic PNGs in
// place of paid/keyed upstream access. Never requests a map service.
import http from 'node:http'
import { readFileSync } from 'node:fs'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII='
const source = readFileSync(new URL('../apps/pwa/src/features/kabandas/tiles/worker.js', import.meta.url), 'utf8')
const fixture = `
self.KABANDA_YANDEX_TILES = { key: 'synthetic-only' };
const networkFetch = self.fetch.bind(self);
let upstreamOffline = false;
self.addEventListener('message', event => {
  if (event.data === 'FIXTURE_UPSTREAM_OFFLINE') { upstreamOffline = true; event.ports[0].postMessage(true); }
});
self.fetch = async (input, options) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://tiles.api-maps.yandex.ru') return networkFetch(input, options);
  if (upstreamOffline || !navigator.onLine) throw new TypeError('fixture offline');
  if (url.searchParams.get('x') === '1') return new Response('denied', { status: 403 });
  return new Response(Uint8Array.from(atob('${png}'), c => c.charCodeAt(0)), { headers: { 'Content-Type': 'image/png' } });
};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
`
http.createServer((request, response) => {
  if (request.url.startsWith('/worker.js')) {
    response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/' })
    response.end(fixture + source)
  } else {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
    response.end('<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tile cache test</title><body>Изолированная проверка кэша Яндекса</body></html>')
  }
}).listen(4211, '127.0.0.1')
