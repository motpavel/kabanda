import { expect, test } from '@playwright/test'
import {
  api,
  fixture,
  installSyntheticSession,
  type FixtureIdentity,
} from './support.js'

test('owner completes one canonical raid and opens the next raid form', async ({ context, page }) => {
  const identity = fixture<FixtureIdentity>('prepare')
  const pageErrors: Error[] = []
  page.on('pageerror', (error) => pageErrors.push(error))
  await installSyntheticSession(context, identity)
  page.on('dialog', (dialog) => void dialog.accept())
  await page.goto('/app')
  await expect(page.getByRole('heading', { name: 'Главная' })).toBeVisible()

  await page.getByRole('link', { name: 'Кабанда', exact: true }).click()
  await page.getByRole('button', { name: 'Создать Кабанду', exact: true }).click()
  await page.getByLabel('Название Кабанды').fill(`E2E Кабанда ${identity.runId.slice(0, 8)}`)
  const createKabandaResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/kabandas') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Создать', exact: true }).click()
  const kabanda = (await (await createKabandaResponse).json()).kabanda as { id: string }
  fixture('attach-point', kabanda.id)
  await page.reload()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Управление Кабандой' }).click()
  const teamMenu = page.getByRole('menu')
  await expect(teamMenu.getByRole('menuitem')).toHaveText([
    'Переименовать Кабанду',
    'Сменить заставку',
    'Передать права вожака',
    'Удалить участников',
  ])
  await expect(page.locator('.kb-team-menu-dots i')).toHaveCount(3)
  await expect(teamMenu).not.toHaveCSS('box-shadow', 'none')
  const [menuBox, coverBox] = await Promise.all([
    teamMenu.boundingBox(),
    page.locator('.kb-team-cover').boundingBox(),
  ])
  expect(menuBox).not.toBeNull()
  expect(coverBox).not.toBeNull()
  expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeGreaterThan((coverBox?.y ?? 0) + (coverBox?.height ?? 0))
  const menuBottomIsClickable = await page.evaluate(({ x, y }) =>
    document.elementFromPoint(x, y)?.closest('.kb-team-menu') !== null,
  {
    x: (menuBox?.x ?? 0) + (menuBox?.width ?? 0) / 2,
    y: Math.min((menuBox?.y ?? 0) + (menuBox?.height ?? 0) - 4, 840),
  })
  expect(menuBottomIsClickable).toBe(true)
  await page.getByRole('menuitem', { name: 'Переименовать Кабанду' }).click()
  await page.getByLabel('Новое название').fill('E2E Городская Кабанда')
  const renameResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/kabandas/${kabanda.id}`) && response.request().method() === 'PATCH')
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  expect((await renameResponse).ok()).toBe(true)
  await expect(page.getByRole('heading', { name: 'E2E Городская Кабанда' })).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 720 })

  const coverResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/kabandas/${kabanda.id}`) && response.request().method() === 'PATCH')
  await page.locator('.kb-team-cover-menu input[type="file"]').setInputFiles('apps/pwa/public/pwa-192x192.png')
  expect((await coverResponse).ok()).toBe(true)
  await expect(page.locator('.kb-team-cover img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('link', { name: 'Карта', exact: true }).click()
  const categorySelect = page.getByLabel('Категория точек')
  await expect(categorySelect).toHaveValue('stores')
  await expect(page.locator('.kb-map-marker--stores')).toHaveCount(177)
  const [categoryBox, viewSwitchBox] = await Promise.all([
    page.locator('.kb-map-category').boundingBox(),
    page.locator('.kb-map-view-switch').boundingBox(),
  ])
  expect(categoryBox).not.toBeNull()
  expect(viewSwitchBox).not.toBeNull()
  expect((categoryBox?.x ?? 0) + (categoryBox?.width ?? 0)).toBeLessThanOrEqual(viewSwitchBox?.x ?? 0)
  expect(Math.abs((categoryBox?.height ?? 0) - (viewSwitchBox?.height ?? 0))).toBeLessThanOrEqual(1)
  expect(Math.abs((categoryBox?.y ?? 0) - (viewSwitchBox?.y ?? 0))).toBeLessThanOrEqual(1)
  await categorySelect.selectOption('attractions')
  await expect(page.locator('.kb-map-marker--stores')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Синтетическая точка E2E\./ })).toBeVisible()
  await expect(page.locator('.kb-map-marker--attractions')).toHaveCount(1)
  await page.setViewportSize({ width: 1280, height: 720 })

  await page.getByRole('link', { name: 'Главная', exact: true }).click()
  await page.getByRole('button', { name: 'Создать рейд' }).click()
  await expect(page.getByRole('heading', { name: 'Новый рейд' })).toBeVisible()
  await page.getByLabel('Название').fill('Синтетический золотой рейд')
  await page.getByRole('button', { name: 'Создать рейд' }).click()
  await page.waitForURL(/\/app\?raid=[0-9a-f-]+$/)
  const raidId = new URL(page.url()).searchParams.get('raid')
  expect(raidId).toBeTruthy()
  const raid = { id: raidId as string }

  await page.getByRole('button', { name: 'Открыть lobby' }).click()
  await page.getByLabel('Выбрать из готовых').selectOption(identity.userId)
  await page.getByRole('button', { name: 'Назначить', exact: true }).click()
  await page.getByRole('button', { name: 'Я готов' }).click()
  await page.getByRole('button', { name: 'Проверить телефон' }).click()
  await page.getByRole('button', { name: 'Начать рейд' }).click()

  await expect(page.getByText('fresh', { exact: true })).toBeVisible({ timeout: 30_000 })
  await context.setGeolocation({ latitude: 56.86001, longitude: 53.21001, accuracy: 8 })
  await expect.poll(async () => {
    const response = await api<{ raid: { routeStatus: { acceptedSampleCount: number } } }>(
      page,
      'GET',
      `/api/raids/${raid.id}`,
    )
    return response.raid.routeStatus.acceptedSampleCount
  }, { timeout: 30_000 }).toBeGreaterThan(0)

  await context.setGeolocation({ latitude: 56.86005, longitude: 53.21005, accuracy: 8 })
  await page.getByRole('button', { name: 'Найти точку рядом' }).click()
  await expect(page.getByText('Синтетическая точка E2E')).toBeVisible()
  await context.setGeolocation({ latitude: 56.8601, longitude: 53.2101, accuracy: 8 })
  await page.getByRole('button', { name: 'Отметиться у точки' }).click()
  await expect(page.getByText(/Попытка сохранена на телефоне/)).toBeVisible()

  await expect.poll(async () => {
    const nearby = await api<{ points: Array<{ creditedByTeam: boolean }> }>(
      page,
      'GET',
      `/api/raids/${raid.id}/check-ins/nearby?latitude=${identity.point.latitude}&longitude=${identity.point.longitude}`,
    )
    return nearby.points[0]?.creditedByTeam ?? false
  }, { timeout: 30_000 }).toBe(true)
  await page.locator('input[type="file"]').setInputFiles('apps/pwa/public/pwa-192x192.png')
  await expect(page.getByText(/Фото сохранено локально/)).toBeVisible()

  await expect.poll(async () => {
    const gallery = await api<{ media: unknown[] }>(page, 'GET', `/api/raids/${raid.id}/media`)
    return gallery.media.length
  }, { timeout: 30_000 }).toBe(1)

  await page.getByRole('button', { name: 'Завершить рейд' }).click()
  await page.getByRole('button', { name: 'Зафиксировать итог' }).click()
  await expect(page.getByText('Канонический итог')).toBeVisible()

  const result = await api<{ result: { team: { uniquePoints: number; photos: number } } }>(
    page,
    'GET',
    `/api/raids/${raid.id}/result`,
  )
  expect(result.result.team).toMatchObject({ uniquePoints: 1, photos: 1 })

  await page.getByRole('link', { name: 'КАБАНДА — на главную' }).click()
  await expect(page.getByRole('heading', { name: 'Главная' })).toBeVisible()
  await page.getByRole('link', { name: 'Рейды', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Рейды' })).toBeVisible()
  expect(pageErrors).toEqual([])
  await expect(page.getByRole('link', { name: /Синтетический золотой рейд/ })).toBeVisible()
  await page.getByRole('link', { name: /Синтетический золотой рейд/ }).click()
  await page.getByRole('link', { name: 'Запланировать следующий рейд' }).click()
  await expect(page.getByRole('heading', { name: 'Новый рейд' })).toBeVisible()
})
