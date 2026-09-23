import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './e2e', testMatch: /(?:persistent-cache|gallery-retention|completed-route-visibility|history-cache-privacy|result-recovery|screen-continuity)\.spec\.ts$/,
  workers: 1, timeout: 45_000, reporter: 'line', outputDir: 'test-results/cache',
  use: { baseURL: 'http://127.0.0.1:4197', serviceWorkers: 'block', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }, { name: 'webkit', use: { ...devices['iPhone 13'] } }],
  webServer: { command: 'pnpm --filter @kabanda/pwa exec vite --host 127.0.0.1 --port 4197', url: 'http://127.0.0.1:4197/app', reuseExistingServer: false, env: { VITE_YANDEX_MAPS_API_KEY: 'synthetic-e2e-key' } },
})
