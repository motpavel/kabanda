import { expect, test, type Page } from '@playwright/test'
import { IZHEVSK_KB_STORES } from '../packages/contracts/src/index.js'
import { installYandexMapsMock } from './support.js'

test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
const userId = '11111111-1111-4111-8111-111111111111'
const teamId = '22222222-2222-4222-8222-222222222222'
const pointId = '66666666-6666-4666-8666-666666666666'
const user = { id: userId, email: 'exploration@example.test', username: 'exploration', displayName: 'Тестовый участник', avatarUrl: null, identityKind: 'verified' }
const team = { id: teamId, name: 'Тест истории', avatar: '🐗', coverImage: null, role: 'member', memberCount: 2, pointsCollectionId: null }
const zero = { durationSeconds: 0, distanceMeters: 0, uniquePoints: 0, photos: 0 }
const history = Array.from({ length: 30 }, (_, index) => ({
  raidId: `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`,
  title: `Поездка ${index + 1}`, completedAt: new Date(Date.UTC(2026, 8, 18, 12, -index)).toISOString(),
  partial: false, participated: index >= 24, team: { ...zero, distanceMeters: 1000 }, personal: zero,
}))
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function shell(page: Page) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const body = path === '/api/me' ? { user }
      : path === '/api/kabandas' ? { kabandas: [team] }
      : path.endsWith('/raids') ? { raids: [] }
      : path.endsWith('/raids/history') ? { raids: [], nextCursor: null }
      : path.endsWith('/progress') ? { progress: { team: { ...zero, completedRaids: 30 }, personal: { ...zero, completedRaids: 6 } } }
      : path.endsWith('/members') ? { members: [{ id: userId, displayName: user.displayName, avatarUrl: null, role: 'member' }] }
      : path.includes('templates') ? { templates: [], nextCursor: null } : {}
    await route.fulfill({ json: body })
  })
}
const cards = (page: Page) => page.getByTestId('production-raid-history').locator('.prd-history-card')

async function historyApi(page: Page, before: (scope: string, offset: number) => Promise<'ok' | 'fail'> = async () => 'ok') {
  await page.route('**/raids/history/page?*', async route => {
    const query = new URL(route.request().url()).searchParams
    const scope = query.get('scope') ?? 'all'
    const offset = Number(query.get('cursor') ?? 0)
    if (await before(scope, offset) === 'fail') return route.fulfill({ status: 503, json: { error: { code: 'TEMPORARY', message: 'Synthetic failure' } } })
    const rows = scope === 'mine' ? history.filter(raid => raid.participated) : history
    return route.fulfill({ json: { schemaVersion: 2, scope, raids: rows.slice(offset, offset + 12), nextCursor: rows.length > offset + 12 ? String(offset + 12) : null } })
  })
}

test('later-page failure retains cards; retry and mine find old zero-metric participation', async ({ page }, info) => {
  const gate = deferred()
  let fail = true, secondRequests = 0
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await shell(page)
  await historyApi(page, async (scope, offset) => {
    if (scope === 'all' && offset === 12) { secondRequests++; if (fail) { await gate.promise; return 'fail' } }
    return 'ok'
  })
  try {
    await page.goto(`/app?kabanda=${teamId}&tab=raids`)
    await expect(cards(page)).toHaveCount(12)
    await page.getByRole('button', { name: 'Показать ещё', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Загружаем…', exact: true })).toBeDisabled()
    await expect(cards(page)).toHaveCount(12)
    gate.resolve()
    await expect(page.getByRole('button', { name: 'Повторить загрузку', exact: true })).toBeVisible()
    await expect(cards(page)).toHaveCount(12)
    expect(secondRequests).toBe(1)
    fail = false
    await page.getByRole('button', { name: 'Повторить загрузку', exact: true }).click()
    await expect(cards(page)).toHaveCount(24)
    await page.getByRole('button', { name: 'Показать ещё', exact: true }).click()
    await expect(cards(page)).toHaveCount(30)
    await expect(page.getByRole('button', { name: 'Показать ещё', exact: true })).toHaveCount(0)
    const ids = await cards(page).evaluateAll(elements => elements.map(element => element.getAttribute('href')))
    expect(new Set(ids).size).toBe(30)
    await page.getByRole('button', { name: 'Мои', exact: true }).click()
    await expect(cards(page)).toHaveCount(6)
    await expect(cards(page).first()).toContainText('Поездка 25')
    await expect(cards(page).last()).toContainText('Поездка 30')
    await expect(page.getByText('Ваш первый результат ещё впереди', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('mine-zero-metrics.png') })
    await page.getByRole('button', { name: 'Все', exact: true }).click()
    await expect(cards(page)).toHaveCount(30)
    expect(errors).toEqual([])
  } finally { gate.resolve() }
})

test('a late all-page cannot replace the mine filter while it is selected', async ({ page }) => {
  const gate = deferred()
  let requested = false
  await shell(page)
  await historyApi(page, async (scope, offset) => {
    if (scope === 'all' && offset === 12) { requested = true; await gate.promise }
    return 'ok'
  })
  try {
    await page.goto(`/app?kabanda=${teamId}&tab=raids`)
    await expect(cards(page)).toHaveCount(12)
    await page.getByRole('button', { name: 'Показать ещё', exact: true }).click()
    await expect.poll(() => requested).toBe(true)
    await page.getByRole('button', { name: 'Мои', exact: true }).click()
    await expect(cards(page)).toHaveCount(6)
    gate.resolve()
    await expect(page.getByRole('button', { name: 'Мои', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(cards(page)).toHaveCount(6)
    await expect(cards(page).first()).toContainText('Поездка 25')
    await page.getByRole('button', { name: 'Все', exact: true }).click()
    await expect(cards(page)).toHaveCount(24)
  } finally { gate.resolve() }
})

test('store progress is unknown until confirmed, separates personal/team and opens canonical history', async ({ page, context }, info) => {
  await installYandexMapsMock(context)
  const gate = deferred()
  let progressRequests = 0, historyRequests = 0
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await shell(page)
  await historyApi(page)
  await page.route('**/points/progress?*', async route => {
    progressRequests++
    await gate.promise
    await route.fulfill({ json: { category: 'stores', collectionId: null, complete: true,
      points: IZHEVSK_KB_STORES.map((store, index) => ({ stableId: store.id, pointId: index === 0 ? pointId : null,
        personalCount: index === 0 ? 1 : 0, teamCount: index < 2 ? 1 : 0 })) } })
  })
  await page.route(`**/points/${pointId}/history`, async route => {
    historyRequests++
    await route.fulfill({ json: { visitors: [{ userId, displayName: user.displayName, count: 1 }], personalCount: 1, entries: [], nextOffset: null } })
  })
  try {
    await page.goto(`/app?kabanda=${teamId}&tab=map`)
    const map = page.locator('[data-kabanda-map]')
    const markers = page.locator('.kb-yandex-marker--stores')
    await expect(markers).toHaveCount(IZHEVSK_KB_STORES.length)
    await expect(markers.nth(0)).toHaveAttribute('aria-label', /Посещения пока неизвестны/)
    await expect(markers.nth(0)).toHaveClass(/kb-visit--unknown/)
    await map.evaluate(element => { (window as any).savedMapNode = element })
    gate.resolve()
    await expect(markers.nth(0)).toHaveClass(/kb-visit--personal/)
    await expect(markers.nth(0)).toHaveAttribute('aria-label', /Вы были здесь/)
    await expect(markers.nth(1)).toHaveClass(/kb-visit--team/)
    await expect(markers.nth(1)).toHaveAttribute('aria-label', /Кабанда была здесь/)
    await expect(markers.nth(2)).toHaveClass(/kb-visit--unvisited/)
    expect(await map.evaluate(element => element === (window as any).savedMapNode)).toBe(true)
    expect(progressRequests).toBe(1)
    await markers.nth(0).focus(); await markers.nth(0).press('Enter')
    await expect(page.locator('.kb-point-visit-state')).toHaveText('Вы были здесь')
    await expect(page.getByRole('heading', { name: 'Посещения', exact: true })).toBeVisible()
    await expect.poll(() => historyRequests).toBe(1)
    await page.screenshot({ path: info.outputPath('store-personal-history.png') })
    expect(errors).toEqual([])
  } finally { gate.resolve() }
})
