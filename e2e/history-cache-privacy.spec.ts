import { expect, test, type Page } from '@playwright/test'
import { IZHEVSK_KB_STORES } from '../packages/contracts/src/index.js'
import { installYandexMapsMock } from './support.js'

test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
const userId = '11111111-1111-4111-8111-111111111111'
const teamId = '22222222-2222-4222-8222-222222222222'
const pointId = '66666666-6666-4666-8666-666666666666'
const zero = { durationSeconds: 0, distanceMeters: 0, uniquePoints: 0, photos: 0 }
const rows = Array.from({ length: 26 }, (_, index) => ({
  raidId: `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`,
  title: `Сохранённая поездка ${index + 1}`, completedAt: new Date(Date.UTC(2026, 8, 18, 12, -index)).toISOString(),
  partial: false, participated: index === 25, team: { ...zero, distanceMeters: 1000 }, personal: zero,
}))

async function shell(page: Page) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const body = path === '/api/me' ? { user: { id: userId, username: 'historytest', email: 'test@example.test', displayName: 'Тест', identityKind: 'verified', avatarUrl: null } }
      : path === '/api/kabandas' ? { kabandas: [{ id: teamId, name: 'Тестовая Кабанда', role: 'member', avatar: '🐗', coverImage: null, memberCount: 1, pointsCollectionId: null }] }
      : path.endsWith('/raids') ? { raids: [] }
      : path.endsWith('/progress') ? { progress: { team: { ...zero, completedRaids: 26 }, personal: { ...zero, completedRaids: 1 } } }
      : path.endsWith('/members') ? { members: [{ id: userId, displayName: 'Тест', role: 'member', avatarUrl: null }] }
      : path.includes('templates') ? { templates: [], nextCursor: null } : {}
    await route.fulfill({ json: body })
  })
}
async function cachedValues(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('kabanda-raid-reads-v1')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<Array<{ key: string; value: { schemaVersion?: number; scope?: string; raids?: unknown[]; category?: string } }>>((resolve, reject) => {
        const request = db.transaction('snapshots').objectStore('snapshots').getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    } finally { db.close() }
  })
}

for (const width of [320, 390]) test(`loaded history survives API outage and document reload at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 })
  await shell(page)
  let unavailable = false
  await page.route('**/raids/history/page?*', async route => {
    if (unavailable) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Synthetic outage' } } })
    const query = new URL(route.request().url()).searchParams
    const start = Number(query.get('cursor') ?? 0)
    await route.fulfill({ json: { schemaVersion: 2, scope: 'all', raids: rows.slice(start, start + 12), nextCursor: start + 12 < rows.length ? String(start + 12) : null } })
  })
  await page.goto(`/app?kabanda=${teamId}&tab=raids`)
  const cards = page.getByTestId('production-raid-history').locator('.prd-history-card')
  await expect(cards).toHaveCount(12)
  await expect(cards.first().locator('[aria-label="Без личного участия"]')).toHaveText('Не участвовали')
  await page.getByRole('button', { name: 'Показать ещё', exact: true }).click()
  await expect(cards).toHaveCount(24)
  await page.getByRole('button', { name: 'Показать ещё', exact: true }).click()
  await expect(cards).toHaveCount(26)
  await expect(cards.last().locator('[aria-label="Личный результат"]')).toBeVisible()
  await expect.poll(async () => (await cachedValues(page)).find(row => row.value.schemaVersion === 2 && row.value.scope === 'all')?.value.raids?.length).toBe(26)
  unavailable = true
  await page.reload()
  await expect(cards).toHaveCount(26)
  await expect(page.getByTestId('production-raid-history').getByText('Не удалось обновить данные.', { exact: true })).toBeVisible()
  await expect(cards.last()).toContainText('Сохранённая поездка 26')
  await expect(page.getByText('Первый финиш ещё впереди', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
})

test('confirmed access denial removes personal store counters and their read snapshot', async ({ page, context }) => {
  await installYandexMapsMock(context)
  await shell(page)
  await page.route('**/raids/history/page?*', route => route.fulfill({ json: { schemaVersion: 2, scope: 'all', raids: [], nextCursor: null } }))
  let denied = false
  await page.route('**/points/progress?*', async route => {
    if (denied) return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: 'Synthetic access revoked' } } })
    await route.fulfill({ json: { category: 'stores', collectionId: null, complete: true,
      points: IZHEVSK_KB_STORES.map((store, index) => ({ stableId: store.id, pointId: index === 0 ? pointId : null, personalCount: index === 0 ? 1 : 0, teamCount: index === 0 ? 2 : 0 })) } })
  })
  await page.goto(`/app?kabanda=${teamId}&tab=map`)
  const firstMarker = page.locator('.kb-yandex-marker--stores').first()
  await expect(firstMarker).toHaveAttribute('aria-label', /Вы были здесь/)
  await expect.poll(async () => (await cachedValues(page)).some(row => row.value.category === 'stores')).toBe(true)
  await page.getByRole('link', { name: 'Рейды', exact: true }).click()
  denied = true
  await page.getByRole('link', { name: 'Карта', exact: true }).click()
  await expect(firstMarker).toHaveAttribute('aria-label', /Посещения пока неизвестны/)
  await expect(firstMarker).toHaveClass(/kb-visit--unknown/)
  await expect(page.locator('.kb-map-notices')).toContainText('Доступ отозван')
  await expect.poll(async () => (await cachedValues(page)).some(row => row.value.category === 'stores')).toBe(false)
})
