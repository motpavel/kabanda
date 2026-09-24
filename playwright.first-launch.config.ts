import { defineConfig, devices } from '@playwright/test'

// Requires a production build with VITE_YANDEX_TILES_API_KEY configured.
export default defineConfig({
  testDir: './e2e', testMatch: /pwa-first-launch\.spec\.ts$/,
  workers: 1, timeout: 45_000, reporter: 'line', outputDir: 'test-results/first-launch',
  use: { baseURL: 'http://127.0.0.1:4213', serviceWorkers: 'allow' },
  projects: [
    { name: 'chromium', use: { ...devices['Pixel 7'] } },
    { name: 'webkit', use: { ...devices['iPhone 13'] } },
  ],
  webServer: { command: 'pnpm --filter @kabanda/pwa exec vite preview --host 127.0.0.1 --port 4213', url: 'http://127.0.0.1:4213/app', reuseExistingServer: false },
})
