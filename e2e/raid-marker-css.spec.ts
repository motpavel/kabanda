import { expect, test } from '@playwright/test'

test('map marker buttons keep their shape, color and anchor under app button styles', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/app')
  // Isolate the three layout states using the shipped app stylesheet. The
  // golden raid also checks real Yandex-layout buttons before/after check-in.
  await page.evaluate(() => {
    document.body.innerHTML = '<main class="kb-shell"><section class="raid-active-map"><button class="raid-live-point" aria-label="Normal" style="position:absolute;left:100px;top:180px"></button><button class="raid-live-point raid-live-point--nearby" aria-label="Nearby" style="position:absolute;left:100px;top:280px"></button><button class="raid-live-point raid-live-point--visited" aria-label="Visited" style="position:absolute;left:100px;top:380px"></button></section></main>'
  })
  for (const [name, size, border, color] of [
    ['Normal', 18, 5, 'rgb(234, 62, 53)'],
    ['Nearby', 24, 6, 'rgb(234, 62, 53)'],
    ['Visited', 18, 5, 'rgb(133, 214, 154)'],
  ] as const) {
    const marker = page.getByRole('button', { name, exact: true })
    const assertShape = async () => {
      await expect(marker).toHaveCSS('width', `${size}px`)
      await expect(marker).toHaveCSS('height', `${size}px`)
      await expect(marker).toHaveCSS('min-height', '0px')
      await expect(marker).toHaveCSS('padding', '0px')
      await expect(marker).toHaveCSS('border-radius', '50%')
      await expect(marker).toHaveCSS('border-top-width', `${border}px`)
      await expect(marker).toHaveCSS('border-top-color', color)
      await expect(marker).toHaveCSS('transform', `matrix(1, 0, 0, 1, -${size / 2}, -${size / 2})`)
    }
    await assertShape()
    await marker.hover()
    await assertShape()
    await page.mouse.down()
    try { await assertShape() } finally { await page.mouse.up() }
  }
})
