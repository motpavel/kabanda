import { expect, test, type Page } from '@playwright/test'

const userId = '11111111-1111-4111-8111-111111111111'
const teamId = '22222222-2222-4222-8222-222222222222'
const user = { id: userId, email: 'trust@example.test', username: 'trust-rider', displayName: 'Тестовый участник', avatarUrl: null, identityKind: 'verified' }
const team = { id: teamId, name: 'Проверка доверия', avatar: '🐗', coverImage: null, role: 'member', memberCount: 1, pointsCollectionId: null }
const metrics = { durationSeconds: 0, distanceMeters: 0, uniquePoints: 0, photos: 0, completedRaids: 0 }

async function mockHome(page: Page, state: { me: number; teams?: number; login?: 'network' | 'invalid' | 'ok' }) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/login') {
      if (state.login === 'network') return route.abort('internetdisconnected')
      if (state.login === 'invalid') return route.fulfill({ status: 401, json: { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid' } } })
      state.me = 200
      return route.fulfill({ json: { user } })
    }
    if (path === '/api/me' && state.me !== 200) return route.fulfill({ status: state.me, json: { error: { code: 'TEST_ERROR', message: 'Synthetic error' } } })
    if (path === '/api/kabandas' && state.teams && state.teams !== 200) return route.fulfill({ status: state.teams, json: { error: { code: 'TEST_ERROR', message: 'Synthetic error' } } })
    const body = path === '/api/me' ? { user }
      : path === '/api/kabandas' ? { kabandas: [team] }
      : path.endsWith('/raids/history') ? { raids: [], nextCursor: null }
      : path.endsWith('/raids') ? { raids: [] }
      : path.endsWith('/progress') ? { progress: { team: metrics, personal: metrics } }
      : path.endsWith('/members') ? { members: [{ id: userId, displayName: user.displayName, role: 'member', avatarUrl: null }] }
      : path.includes('templates') ? { templates: [], nextCursor: null } : {}
    return route.fulfill({ json: body })
  })
}

for (const status of [503, 429]) test(`a ${status} session response is retryable without false logout`, async ({ page }) => {
  const state = { me: status }
  await mockHome(page, state)
  await page.goto(`/app?kabanda=${teamId}&tab=raids`)
  await expect(page.getByTestId('session-unavailable')).toBeVisible()
  await expect(page.getByLabel('Пароль', { exact: true })).toHaveCount(0)
  state.me = 200
  await page.getByRole('button', { name: 'Повторить проверку', exact: true }).click()
  await expect(page.getByTestId('production-raids-hub')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`kabanda=${teamId}&tab=raids`))
  await expect(page.getByTestId('session-unavailable')).toHaveCount(0)
})

test('a denied session does not look like an invalid password', async ({ page }) => {
  await mockHome(page, { me: 403 })
  await page.goto('/app')
  await expect(page.getByTestId('session-unavailable')).toContainText('Доступ')
  await expect(page.getByLabel('Пароль', { exact: true })).toHaveCount(0)
})

test('login distinguishes network failure from invalid credentials and keeps the form', async ({ page }) => {
  const state: { me: number; login: 'network' | 'invalid' | 'ok' } = { me: 401, login: 'network' }
  await mockHome(page, state)
  await page.goto('/app')
  await page.getByLabel('Логин', { exact: true }).fill('trust-rider')
  await page.getByLabel('Пароль', { exact: true }).fill('synthetic-password')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('связаться с сервером')
  await expect(page.getByLabel('Логин', { exact: true })).toHaveValue('trust-rider')
  await expect(page.getByLabel('Пароль', { exact: true })).toHaveValue('synthetic-password')
  state.login = 'invalid'
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Неверный логин или пароль')
  state.login = 'ok'
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Соберёмся на прогулку?' })).toBeVisible()
})

test('a team read failure is not an empty membership and retries without reload', async ({ page }) => {
  const state = { me: 200, teams: 503 }
  await mockHome(page, state)
  await page.goto('/app')
  await expect(page.getByRole('alert')).toContainText('Не удалось загрузить Кабанды')
  await expect(page.getByRole('heading', { name: 'Пока без Кабанды' })).toHaveCount(0)
  state.teams = 200
  await page.getByRole('button', { name: 'Повторить', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Соберёмся на прогулку?' })).toBeVisible()
})

async function renewSameAccount(page: Page) {
  await page.evaluate(identityId => window.dispatchEvent(new StorageEvent('storage', {
    key: 'kabanda:relay-session:v1',
    oldValue: JSON.stringify({ opaque: 'synthetic-before', identityId }),
    newValue: JSON.stringify({ opaque: 'synthetic-after', identityId }),
  })), userId)
}

for (const status of [503, 429]) test(`an already open screen survives ${status} session revalidation without remount`, async ({ page }) => {
  const state = { me: 200 }
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await mockHome(page, state)
  await page.goto(`/app?kabanda=${teamId}&tab=raids`)
  const hub = page.getByTestId('production-raids-hub')
  await expect(hub).toBeVisible()
  await page.evaluate(() => Object.assign(window, { trustHubNode: document.querySelector('[data-testid="production-raids-hub"]') }))
  state.me = status
  await renewSameAccount(page)
  await expect(page.getByRole('button', { name: 'Повторить проверку', exact: true })).toBeVisible()
  await expect(hub).toBeVisible()
  await expect(page.getByLabel('Пароль', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { trustHubNode: Element }).trustHubNode === document.querySelector('[data-testid="production-raids-hub"]'))).toBe(true)
  state.me = 200
  await page.getByRole('button', { name: 'Повторить проверку', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Повторить проверку', exact: true })).toHaveCount(0)
  await expect(hub).toBeVisible()
  expect(pageErrors).toEqual([])
})

test('confirmed 401 removes a previously open private screen and permits a fresh login', async ({ page }) => {
  const state = { me: 200, login: 'ok' as const }
  await mockHome(page, state)
  await page.goto(`/app?kabanda=${teamId}&tab=raids`)
  await expect(page.getByTestId('production-raids-hub')).toBeVisible()
  state.me = 401
  await renewSameAccount(page)
  await expect(page.getByLabel('Пароль', { exact: true })).toBeVisible()
  await expect(page.getByTestId('production-raids-hub')).toHaveCount(0)
  await page.getByLabel('Логин', { exact: true }).fill('trust-rider')
  await page.getByLabel('Пароль', { exact: true }).fill('synthetic-password')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByTestId('production-raids-hub')).toBeVisible()
})
