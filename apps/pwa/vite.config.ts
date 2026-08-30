import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const e2eMode = process.env.KABANDA_E2E === 'true'
const base = !e2eMode && process.env.GITHUB_ACTIONS ? '/kabanda/' : '/'
const rawAppVersion = process.env.GITHUB_SHA?.slice(0, 12) ?? process.env.npm_package_version ?? 'dev'
const appVersion = /^[A-Za-z0-9._-]{1,64}$/.test(rawAppVersion) ? rawAppVersion : 'dev'
const swBuildAsset = `sw-build-${appVersion}.js`

function serviceWorkerBuildResponder(): Plugin {
  return {
    name: 'kabanda-service-worker-build-responder',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: swBuildAsset,
        source: `self.addEventListener('message',function(event){if(event.data&&event.data.type==='KABANDA_SW_BUILD'&&event.ports&&event.ports[0])event.ports[0].postMessage({build:${JSON.stringify(appVersion)}})})`,
      })
    },
  }
}

export default defineConfig({
  base,
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
  preview: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(
      appVersion,
    ),
    __ALPHA_DIAGNOSTICS__: JSON.stringify(process.env.VITE_ALPHA_DIAGNOSTICS === 'true'),
  },
  plugins: [
    react(),
    serviceWorkerBuildResponder(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: [
        'apple-touch-icon.png',
        'pwa-192x192.png',
        'pwa-512x512.png',
        'brand/kabanda-logo-reference.png',
        'brand/kabanda-login-riders.jpg',
      ],
      manifest: {
        name: 'КАБАНДА',
        short_name: 'КАБАНДА',
        description: 'Общие городские велорейды, точки и история Кабанды',
        lang: 'ru',
        theme_color: '#232a35',
        background_color: '#f7f7f5',
        display: 'standalone',
        orientation: 'any',
        start_url: `${base}app`,
        scope: base,
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        cleanupOutdatedCaches: true,
        importScripts: [swBuildAsset],
        navigateFallbackDenylist: [/^\/api(?:\/|$)/],
        runtimeCaching: []
      },
      devOptions: {
        enabled: true,
        type: 'module'
      }
    })
  ]
})
