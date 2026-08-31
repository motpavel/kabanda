import { expect, test } from '@playwright/test'

test('raids hub wraps routes into two columns and only shows joined upcoming raids', async ({ page }) => {
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
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/prototype/raids?capture=1&variant=upcoming-cases')
  await expect(page.getByRole('heading', { name: 'Предстоящие' })).toBeVisible()
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
