import { defineConfig, devices } from '@playwright/test'

const databaseUrl = process.env.E2E_DATABASE_URL ?? ''

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results/primary',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/primary-report.json' }]] : 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    geolocation: { latitude: 56.86, longitude: 53.21, accuracy: 8 },
    permissions: ['geolocation'],
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'webkit', use: { ...devices['iPhone 13'] },
      testMatch: /(?:browser-photo|field-sync-server|field-retry-navigation|gallery-retention|raid-layout-regressions|result-recovery|user-trust-session|recording-navigation|offline-recovery)\.spec\.ts$/,
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @kabanda/api start',
      url: 'http://127.0.0.1:3000/api/ready',
      reuseExistingServer: false,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        APP_ORIGIN: 'http://127.0.0.1:4173',
        API_HOST: '127.0.0.1',
        API_PORT: '3000',
      },
    },
    {
      command: 'pnpm --filter @kabanda/pwa preview --host 127.0.0.1 --port 4173',
      url: 'http://127.0.0.1:4173/app',
      reuseExistingServer: false,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        GITHUB_ACTIONS: '',
        KABANDA_E2E: 'true',
      },
    },
  ],
})
