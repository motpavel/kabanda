#!/usr/bin/env node

const [originArgument, expectedBuild] = process.argv.slice(2)
if (!originArgument || !expectedBuild) {
  throw new Error('Usage: node infra/stand/smoke.mjs <https-origin> <exact-build-id>')
}

const origin = new URL(originArgument).origin
if (new URL(origin).protocol !== 'https:') throw new Error('Public smoke requires HTTPS')

async function request(path, init = {}) {
  const response = await fetch(new URL(path, origin), { redirect: 'manual', ...init })
  const build = response.headers.get('x-kabanda-app-build')
  if (build !== expectedBuild) {
    throw new Error(`${path}: expected build ${expectedBuild}, received ${build ?? 'none'}`)
  }
  return response
}

function expectStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}`)
  }
}

const app = await request('/app', {
  headers: { accept: 'text/html' },
})
expectStatus(app, 200, 'PWA shell')
const html = await app.text()
if (!html.toLowerCase().includes('<!doctype html')) throw new Error('PWA shell is not HTML')
if (app.headers.get('cache-control') !== 'no-store') throw new Error('PWA shell must not be cached')
if (!html.includes('href="/pwa-192x192.png"') || !html.includes('href="/apple-touch-icon.png"')) {
  throw new Error('PWA shell must use canonical root icon paths')
}

const icon = await request('/pwa-192x192.png')
expectStatus(icon, 200, 'PWA icon')
const appleTouchIcon = await request('/apple-touch-icon.png')
expectStatus(appleTouchIcon, 200, 'apple touch icon')

const manifest = await request('/manifest.webmanifest')
expectStatus(manifest, 200, 'manifest')
if (manifest.headers.get('cache-control') !== 'no-store') throw new Error('manifest must not be cached')
const manifestBody = await manifest.json()
if (manifestBody.lang !== 'ru') throw new Error(`manifest language must be ru, received ${manifestBody.lang ?? 'none'}`)

const serviceWorker = await request('/sw.js')
expectStatus(serviceWorker, 200, 'service worker')
if (serviceWorker.headers.get('cache-control') !== 'no-store') {
  throw new Error('service worker must not be cached')
}
const serviceWorkerBody = await serviceWorker.text()
const clientBuild = expectedBuild.slice(0, 12)
const pwaBuildMarker = `sw-build-${clientBuild}.js`
if (!serviceWorkerBody.includes(pwaBuildMarker)) {
  throw new Error(`service worker does not reference exact PWA build marker ${pwaBuildMarker}`)
}
const buildMarker = await request(`/${pwaBuildMarker}`)
expectStatus(buildMarker, 200, 'PWA build marker')
if (!(await buildMarker.text()).includes(`build:${JSON.stringify(clientBuild)}`)) {
  throw new Error(`PWA build marker does not contain ${clientBuild}`)
}

const assetPath = html.match(/<script[^>]+src="(\/assets\/[^"]+)"/)?.[1]
if (!assetPath) throw new Error('PWA shell contains no hashed JavaScript asset')
const asset = await request(assetPath)
expectStatus(asset, 200, 'hashed asset')
if (!asset.headers.get('cache-control')?.includes('immutable')) {
  throw new Error('hashed asset is not immutable')
}
const assetBody = await asset.text()
if (!assetBody.includes('https://api-maps.yandex.ru/2.1/')) {
  throw new Error('PWA bundle does not contain Yandex Maps JavaScript API 2.1')
}
if (assetBody.includes('https://yandex.ru/map-widget/v1/?ll=')) {
  throw new Error('PWA bundle still contains the legacy Yandex iframe map')
}

const health = await request('/api/health')
expectStatus(health, 200, 'liveness')
const ready = await request('/api/ready')
expectStatus(ready, 200, 'readiness')

const canonicalLogout = await request('/api/auth/logout', {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: '{}',
})
expectStatus(canonicalLogout, 204, 'canonical mutation')

const foreignLogout = await request('/api/auth/logout', {
  method: 'POST',
  headers: { origin: 'https://foreign-origin.invalid', 'content-type': 'application/json' },
  body: '{}',
})
expectStatus(foreignLogout, 403, 'foreign-origin mutation')

process.stdout.write(`Kabanda public smoke passed: ${origin} @ ${expectedBuild}\n`)
