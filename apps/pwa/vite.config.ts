import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath } from 'node:url'

const e2eMode = process.env.KABANDA_E2E === 'true'
const base = process.env.VITE_APP_BASE === '/' ? '/' : !e2eMode && process.env.GITHUB_ACTIONS ? '/kabanda/' : '/'
const rawAppVersion = process.env.GITHUB_SHA?.slice(0, 12) ?? process.env.npm_package_version ?? 'dev'
const appVersion = /^[A-Za-z0-9._-]{1,64}$/.test(rawAppVersion) ? rawAppVersion : 'dev'
const swBuildAsset = `sw-build-${appVersion}.js`
const optionalPrecacheJs = new Set<string>()

function serviceWorkerBuildResponder(tileWorker?: { fileName: string; source: string }): Plugin {
  return {
    name: 'kabanda-service-worker-build-responder',
    configureServer(server) {
      if (!tileWorker) return
      server.middlewares.use((request, response, next) => {
        if (new URL(request.url ?? '/', 'http://localhost').pathname !== `${base}${tileWorker.fileName}`) return next()
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        response.setHeader('Cache-Control', 'no-store')
        response.end(tileWorker.source)
      })
    },
    generateBundle(_options, bundle) {
      if (tileWorker) this.emitFile({ type: 'asset', ...tileWorker })
      optionalPrecacheJs.clear()
      const corePrecacheJs = new Set<string>()
      const include = (fileName: string) => {
        if (corePrecacheJs.has(fileName)) return
        corePrecacheJs.add(fileName)
        const chunk = bundle[fileName]
        if (chunk?.type === 'chunk') chunk.imports.forEach(include)
      }
      // Keep the complete app/recording dependency graph and GPS lab offline.
      // Only optional prototypes and desktop decoration may be fetched later.
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && (chunk.isEntry || chunk.facadeModuleId?.includes('/capability-lab/'))) include(chunk.fileName)
      }
      const optionalOnly = (fileName: string) => {
        if (corePrecacheJs.has(fileName) || optionalPrecacheJs.has(fileName)) return
        optionalPrecacheJs.add(fileName)
        const chunk = bundle[fileName]
        if (chunk?.type === 'chunk') chunk.imports.forEach(optionalOnly)
      }
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && /\/(?:prototype|raids-design|route-tracking-prototype)\/|\/kabanda-motion\.ts$/.test(chunk.facadeModuleId ?? '')) optionalOnly(chunk.fileName)
      }
      this.emitFile({
        type: 'asset',
        fileName: swBuildAsset,
        source: `self.addEventListener('message',function(event){if(event.data&&event.data.type==='KABANDA_SW_BUILD'&&event.ports&&event.ports[0])event.ports[0].postMessage({build:${JSON.stringify(appVersion)}})})`,
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env }
  const tilesKey = env.VITE_YANDEX_TILES_API_KEY?.trim() ?? ''
  const tileSource = tilesKey ? `self.KABANDA_YANDEX_TILES=${JSON.stringify({ key: tilesKey })};\n` + readFileSync(new URL('./src/features/kabandas/tiles/worker.js', import.meta.url), 'utf8') : ''
  const tileWorker = tileSource ? { fileName: `assets/yandex-tile-worker-${createHash('sha256').update(tileSource).digest('hex').slice(0, 12)}.js`, source: tileSource } : undefined
  return {
  base,
  build: {
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        gpsLab: fileURLToPath(new URL('./lab/index.html', import.meta.url)),
      },
    },
  },
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  server: {
    proxy: {
      '/api': process.env.KABANDA_API_PROXY ?? 'http://127.0.0.1:3000',
    },
  },
  preview: {
    proxy: {
      '/api': process.env.KABANDA_API_PROXY ?? 'http://127.0.0.1:3000',
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(
      appVersion,
    ),
    __ALPHA_DIAGNOSTICS__: JSON.stringify(process.env.VITE_ALPHA_DIAGNOSTICS === 'true'),
    __YANDEX_TILES_ENABLED__: JSON.stringify(Boolean(tilesKey)),
  },
  plugins: [
    react(),
    serviceWorkerBuildResponder(tileWorker),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: [
        'gps-lab.webmanifest',
        'lab/manifest.webmanifest',
        'kabanda-bike-apple-180.png',
        'kabanda-bike-192.png',
        'kabanda-bike-512.png',
        'kabanda-bike-maskable-512.png',
        'brand/kabanda-logo-reference.png',
        'brand/kabanda-wordmark-ui.png',
        'brand/kabanda-navigation-v1.png',
      ],
      manifest: {
        name: 'КАБАНДА',
        short_name: 'КАБАНДА',
        description: 'Общие городские велорейды, точки и история Кабанды',
        lang: 'ru',
        theme_color: '#232a35',
        background_color: '#f7f7f5',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: `${base}app`,
        scope: base,
        icons: [
          {
            src: 'kabanda-bike-192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'kabanda-bike-512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'kabanda-bike-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        // Attach the first installed worker to the already-open page so map
        // caching starts without a second launch. Updates still wait for the
        // recording-aware gate to send SKIP_WAITING.
        clientsClaim: true,
        globPatterns: ['**/*.{js,wasm,css,html,woff2}'],
        manifestTransforms: [async (entries) => ({
          manifest: entries.filter(({ url }) => {
            if (/^assets\/geist-/.test(url)) return false
            if (/^assets\/(?:PrototypePage|RouteTrackingPrototype)-.*\.css$/.test(url)) return false
            // Default to caching new app assets; exclude only known optional trees.
            return !optionalPrecacheJs.has(url)
          }),
          warnings: [],
        })],
        cleanupOutdatedCaches: true,
        importScripts: [swBuildAsset, ...(tileWorker ? [tileWorker.fileName] : [])],
        navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/relay(?:\/|$)/, /^\/(?:kabanda\/)?_yandex_tiles\//, /^\/(?:kabanda\/)?lab(?:[/?]|$)/],
        // Only public, bundled art. Authenticated API, covers and map/GPS responses
        // remain network-only; never leak one member's data into a shared SW cache.
        runtimeCaching: [{
          // Hashed public chunks/fonts are immutable. Never cache API or Relay.
          urlPattern: ({ url, request, sameOrigin }) => sameOrigin === true && /^\/(?:kabanda\/)?assets\//.test(url.pathname) && ['script', 'style', 'font', 'worker'].includes(request.destination),
          handler: 'CacheFirst',
          options: {
            cacheName: 'kabanda-optional-assets',
            cacheableResponse: { statuses: [200] },
            expiration: { maxEntries: 80, maxAgeSeconds: 30 * 24 * 60 * 60 },
          },
        }, {
          // Lab navigations must never receive the main app's install metadata.
          urlPattern: ({ url, request, sameOrigin }) => sameOrigin === true && request.mode === 'navigate' && /^\/(?:kabanda\/)?lab(?:\/|$)/.test(url.pathname),
          handler: 'NetworkFirst',
          options: {
            cacheName: 'kabanda-gps-pages',
            cacheableResponse: { statuses: [200] },
          },
        }, {
          urlPattern: ({ url, request, sameOrigin }) => sameOrigin === true && request.destination === 'image' && /^\/(?:kabanda\/)?brand\//.test(url.pathname),
          handler: 'StaleWhileRevalidate',
          options: {
            cacheName: 'kabanda-public-art',
            cacheableResponse: { statuses: [200] },
            expiration: { maxEntries: 64, maxAgeSeconds: 30 * 24 * 60 * 60 },
          },
        }]
      },
      devOptions: {
        enabled: true,
        type: 'module'
      }
    }),
    {
      name: 'kabanda-gps-install-metadata',
      enforce: 'post',
      transformIndexHtml: {
        order: 'post',
        handler(html, context) {
          if (!context.filename.endsWith('/lab/index.html')) return html
          // VitePWA injects the main manifest into every HTML entry. Replace it
          // at build time, before Safari reads any install metadata.
          return html.replace(/<link\b[^>]*\brel=["']manifest["'][^>]*>/g, '')
            .replace('</head>', `<link rel="manifest" href="${base}lab/manifest.webmanifest" /></head>`)
        },
      },
    },
  ]
  }
})
