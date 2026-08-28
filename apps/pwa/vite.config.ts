import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const base = process.env.GITHUB_ACTIONS ? '/kabanda/' : '/'

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
  define: {
    __APP_VERSION__: JSON.stringify(
      process.env.GITHUB_SHA?.slice(0, 7) ?? process.env.npm_package_version ?? 'dev',
    ),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'КАБАНДА',
        short_name: 'КАБАНДА',
        description: 'Общие городские велорейды, точки и история Кабанды',
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
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: []
      },
      devOptions: {
        enabled: true,
        type: 'module'
      }
    })
  ]
})
