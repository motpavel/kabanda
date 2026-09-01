import { expect, test } from '@playwright/test'

test('raids hub keeps responsive routes, history, and joined upcoming raids', async ({ page }) => {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.goto('/prototype/raids?capture=1&variant=upcoming-empty')

    const routeCards = page.locator('.rdp-route-card')
    await expect(routeCards).toHaveCount(3)
    await expect(page.getByText('Подробнее', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Предстоящие' })).toHaveCount(0)

    const layout = await page.locator('.rdp-routes').evaluate((element) => {
      const cards = [...element.querySelectorAll<HTMLElement>('.rdp-route-card')]
      const boxes = cards.map((card) => card.getBoundingClientRect())
      return {
        clientWidth: element.clientWidth,
        columns: getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length,
        scrollWidth: element.scrollWidth,
        boxes: boxes.map(({ bottom, height, width, x, y }) => ({ bottom, height, width, x, y })),
      }
    })

    expect(layout.columns).toBe(2)
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1)
    expect(Math.abs(layout.boxes[0]!.y - layout.boxes[1]!.y)).toBeLessThanOrEqual(1)
    expect(layout.boxes[1]!.x).toBeGreaterThan(layout.boxes[0]!.x)
    expect(layout.boxes[2]!.y).toBeGreaterThanOrEqual(layout.boxes[0]!.bottom)
    expect(Math.abs(layout.boxes[2]!.x - layout.boxes[0]!.x)).toBeLessThanOrEqual(1)
    expect(documentWidth(layout.boxes)).toBeLessThanOrEqual(viewport.width)

    const historyCards = page.locator('.rdp-history-card')
    const historyFilters = page.locator('.rdp-history-filters')
    await expect(historyCards).toHaveCount(3)

    const heroHeights = await historyCards.locator('.rdp-history-card__hero').evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().height),
    )
    expect(heroHeights).toHaveLength(3)
    for (const height of heroHeights) {
      expect(height).toBeGreaterThanOrEqual(77)
      expect(height).toBeLessThanOrEqual(82)
    }

    const filterGeometry = await historyFilters.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }))
    expect(filterGeometry.scrollWidth).toBeLessThanOrEqual(filterGeometry.clientWidth + 1)

    const filterHeights = await historyFilters.locator('button').evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().height),
    )
    expect(filterHeights).toHaveLength(3)
    for (const height of filterHeights) expect(height).toBeGreaterThanOrEqual(44)

    const historyBoxes = await historyCards.evaluateAll((elements) =>
      elements.map((element) => {
        const { right, x } = element.getBoundingClientRect()
        return { right, x }
      }),
    )
    for (const box of historyBoxes) {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(viewport.width + 1)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/prototype/raids?capture=1&variant=upcoming-empty')

  const historyCards = page.locator('.rdp-history-card')
  const allFilter = page.getByRole('button', { name: 'Все', exact: true })
  const mineFilter = page.getByRole('button', { name: 'Мои', exact: true })
  const routesFilter = page.getByRole('button', { name: 'С маршрутами', exact: true })
  await expect(historyCards).toHaveCount(3)
  await expect(allFilter).toHaveAttribute('aria-pressed', 'true')
  await expect(mineFilter).toHaveAttribute('aria-pressed', 'false')
  await expect(routesFilter).toHaveAttribute('aria-pressed', 'false')

  const secondHistoryCard = historyCards.nth(1)
  const gallery = secondHistoryCard.locator('.rdp-history-gallery')
  await expect(gallery.locator('.rdp-history-gallery__item')).toHaveCount(5)
  await expect(gallery.locator('.rdp-history-gallery__item:not(.rdp-history-gallery__more)')).toHaveCount(4)
  await expect(gallery.locator('.rdp-history-gallery__more')).toHaveCount(1)
  await expect(gallery.getByText('+6', { exact: true })).toBeVisible()

  await mineFilter.click()
  await expect(historyCards).toHaveCount(2)
  await expect(allFilter).toHaveAttribute('aria-pressed', 'false')
  await expect(mineFilter).toHaveAttribute('aria-pressed', 'true')
  await expect(routesFilter).toHaveAttribute('aria-pressed', 'false')

  await routesFilter.click()
  await expect(historyCards).toHaveCount(2)
  await expect(allFilter).toHaveAttribute('aria-pressed', 'false')
  await expect(mineFilter).toHaveAttribute('aria-pressed', 'false')
  await expect(routesFilter).toHaveAttribute('aria-pressed', 'true')

  await page.goto('/prototype/raids?capture=1&variant=upcoming-cases')
  await expect(page.getByRole('heading', { name: 'Предстоящие' })).toBeVisible()
  await expect(page.locator('section[aria-labelledby="upcoming-heading"] .rdp-row')).toHaveCount(2)
  await expect(page.getByText('Вы едете', { exact: true })).toHaveCount(2)

  const newRaidButton = page.getByRole('button', { name: /Новый рейд/ })
  await newRaidButton.click()
  const closeButton = page.getByRole('button', { name: 'Закрыть' })
  const closeBox = await closeButton.boundingBox()
  expect(closeBox).not.toBeNull()
  expect(closeBox?.width).toBe(44)
  expect(closeBox?.height).toBe(44)
  await expect(closeButton.locator('svg')).toHaveCount(1)
  await expect(closeButton).toHaveText('')
  await closeButton.click()
  await expect(page.getByRole('dialog', { name: 'Как едем?' })).toHaveCount(0)
  await expect(newRaidButton).toBeFocused()
})

function documentWidth(boxes: Array<{ width: number; x: number }>): number {
  return Math.max(...boxes.map(({ width, x }) => width + x))
}
