import { expect, test } from '@playwright/test'
import {
  api,
  fixture,
  installSyntheticSession,
  type FixtureIdentity,
} from './support.js'

test('owner completes one canonical raid and opens the next raid form', async ({ context, page }) => {
  const identity = fixture<FixtureIdentity>('prepare')
  await installSyntheticSession(context, identity)
  page.on('dialog', (dialog) => void dialog.accept())
  await page.goto('/app')
  await expect(page.getByRole('heading', { name: 'Мои Кабанды' })).toBeVisible()

  await page.getByRole('button', { name: '+ Кабанда' }).click()
  await page.getByLabel('Название Кабанды').fill(`E2E Кабанда ${identity.runId.slice(0, 8)}`)
  const createKabandaResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/kabandas') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Создать', exact: true }).click()
  const kabanda = (await (await createKabandaResponse).json()).kabanda as { id: string }
  fixture('attach-point', kabanda.id)
  await page.reload()
  await expect(page.getByText('Синтетическая точка E2E')).toBeVisible()

  await page.getByRole('button', { name: 'Создать рейд' }).click()
  await expect(page.getByRole('heading', { name: 'Новый рейд' })).toBeVisible()
  await page.getByLabel('Название').fill('Синтетический золотой рейд')
  const createRaidResponse = page.waitForResponse((response) =>
    response.url().includes(`/api/kabandas/${kabanda.id}/raids`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Создать рейд' }).click()
  const raid = (await (await createRaidResponse).json()).raid as { id: string }

  await page.getByRole('button', { name: 'Открыть lobby' }).click()
  await page.getByLabel('Выбрать из готовых').selectOption(identity.userId)
  await page.getByRole('button', { name: 'Назначить', exact: true }).click()
  await page.getByRole('button', { name: 'Я готов' }).click()
  await page.getByRole('button', { name: 'Проверить телефон' }).click()
  await page.getByRole('button', { name: 'Начать рейд' }).click()

  await expect(page.getByText('fresh', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => {
    const response = await api<{ raid: { routeStatus: { acceptedSampleCount: number } } }>(
      page,
      'GET',
      `/api/raids/${raid.id}`,
    )
    return response.raid.routeStatus.acceptedSampleCount
  }, { timeout: 30_000 }).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Найти точку рядом' }).click()
  await expect(page.getByText('Синтетическая точка E2E')).toBeVisible()
  await page.getByRole('button', { name: 'Отметиться у точки' }).click()
  await page.locator('input[type="file"]').setInputFiles('apps/pwa/public/pwa-192x192.png')

  await expect.poll(async () => {
    const nearby = await api<{ points: Array<{ creditedByTeam: boolean }> }>(
      page,
      'GET',
      `/api/raids/${raid.id}/check-ins/nearby?latitude=${identity.point.latitude}&longitude=${identity.point.longitude}`,
    )
    return nearby.points[0]?.creditedByTeam ?? false
  }, { timeout: 30_000 }).toBe(true)
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
  await expect(page.getByRole('link', { name: /Синтетический золотой рейд/ })).toBeVisible()
  await page.getByRole('link', { name: /Синтетический золотой рейд/ }).click()
  await page.getByRole('link', { name: 'Запланировать следующий рейд' }).click()
  await expect(page.getByRole('heading', { name: 'Новый рейд' })).toBeVisible()
})
