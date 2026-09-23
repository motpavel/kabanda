import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './e2e', testMatch: /yandex-tile-cache\.spec\.ts$/,
  workers: 1, timeout: 30_000, reporter: 'line', outputDir: 'test-results/tiles',
  use: { baseURL: 'http://127.0.0.1:4211', serviceWorkers: 'allow', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Pixel 7'] } },
    { name: 'webkit', use: { ...devices['iPhone 13'] } },
  ],
  webServer: { command: 'node e2e/tile-cache-server.mjs', url: 'http://127.0.0.1:4211', reuseExistingServer: false },
})
