import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './e2e', testMatch: 'data-consistency.spec.ts', workers: 1, timeout: 45_000,
  reporter: 'line',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4183', serviceWorkers: 'block',
    viewport: { width: 390, height: 844 }, trace: 'on', screenshot: 'on', video: 'on' },
  webServer: { command: 'pnpm --filter @kabanda/pwa exec vite --host 127.0.0.1 --port 4183',
    url: 'http://127.0.0.1:4183/app', reuseExistingServer: false },
})
