import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
const identity = '11111111-1111-4111-8111-111111111111'
const team = '22222222-2222-4222-8222-222222222222'
const zero = { durationSeconds: 0, distanceMeters: 0, uniquePoints: 0, photos: 0 }
const rows = Array.from({ length: 24 }, (_, index) => ({
  raidId: `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`,
  title: `Проверочная поездка ${index + 1}`,
  completedAt: new Date(Date.UTC(2026, 8, 18, 12, -index)).toISOString(),
  partial: false, participated: true, team: zero, personal: zero,
}))

for (const malformed of ['empty', 'repeated'] as const) {
  test(`malformed ${malformed} page preserves visible history and can be retried`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    let broken = true, laterRequests = 0
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname
      if (path.endsWith('/raids/history/page')) {
        const scope = url.searchParams.get('scope') ?? 'all'
        const offset = Number(url.searchParams.get('cursor') ?? 0)
        if (offset > 0) {
          laterRequests++
          if (broken) return route.fulfill({ json: {
            schemaVersion: 2, scope, raids: malformed === 'empty' ? [] : rows.slice(0, 12), nextCursor: '24',
          } })
        }
        return route.fulfill({ json: {
          schemaVersion: 2, scope, raids: rows.slice(offset, offset + 12), nextCursor: offset === 0 ? '12' : null,
        } })
      }
      const body = path === '/api/me' ? { user: { id: identity, username: 'protocol', email: 'protocol@example.test', displayName: 'Проверка', identityKind: 'verified', avatarUrl: null } }
        : path === '/api/kabandas' ? { kabandas: [{ id: team, name: 'Проверка истории', role: 'member', avatar: '🐗', coverImage: null, memberCount: 1, pointsCollectionId: null }] }
        : path.endsWith('/raids') ? { raids: [] }
        : path.endsWith('/progress') ? { progress: { team: { ...zero, completedRaids: 24 }, personal: { ...zero, completedRaids: 24 } } }
        : path.endsWith('/members') ? { members: [{ id: identity, displayName: 'Проверка', role: 'member', avatarUrl: null }] }
        : path.includes('templates') ? { templates: [], nextCursor: null } : {}
      return route.fulfill({ json: body })
    })
    await page.goto(`/app?kabanda=${team}&tab=raids`)
    const section = page.getByTestId('production-raid-history')
    const cards = section.locator('.prd-history-card')
    await expect(cards).toHaveCount(12)
    const before = await cards.evaluateAll(elements => elements.map(element => element.getAttribute('href')))
    await section.getByRole('button', { name: 'Показать ещё', exact: true }).click()
    await expect(section.getByRole('button', { name: 'Повторить загрузку', exact: true })).toBeVisible()
    await expect(cards).toHaveCount(12)
    expect(await cards.evaluateAll(elements => elements.map(element => element.getAttribute('href')))).toEqual(before)
    await expect(section.getByRole('button', { name: 'Показать ещё', exact: true })).toBeDisabled()
    expect(laterRequests).toBe(1)
    await expect(section.getByText('Первый финиш ещё впереди', { exact: true })).toHaveCount(0)
    broken = false
    await section.getByRole('button', { name: 'Повторить загрузку', exact: true }).click()
    await expect(cards).toHaveCount(24)
    await expect(cards.last()).toContainText('Проверочная поездка 24')
    await expect(section.getByRole('button', { name: 'Показать ещё', exact: true })).toHaveCount(0)
    const after = await cards.evaluateAll(elements => elements.map(element => element.getAttribute('href')))
    expect(new Set(after).size).toBe(24)
    expect(errors).toEqual([])
  })
}
