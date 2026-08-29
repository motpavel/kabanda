import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { BrowserContext, Page } from '@playwright/test'

export type FixtureIdentity = {
  runId: string
  userId: string
  email: string
  displayName: string
  sessionToken: string
  cookieName: string
  point: { latitude: number; longitude: number }
}

function requireRunId(): string {
  const runId = process.env.E2E_RUN_ID
  if (!runId) throw new Error('E2E_RUN_ID is required')
  return runId
}

export function fixture<T>(
  command: 'prepare' | 'attach-point' | 'inspect-raid',
  ...arguments_: string[]
): T {
  requireRunId()
  const output = execFileSync(
    'pnpm',
    ['--filter', '@kabanda/api', 'e2e:fixture', command, ...arguments_],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  )
  const line = output.trim().split(/\r?\n/).at(-1)
  if (!line) throw new Error(`Empty fixture response for ${command}`)
  return JSON.parse(line) as T
}

export async function installSyntheticSession(
  context: BrowserContext,
  identity: FixtureIdentity,
): Promise<void> {
  await context.addCookies([{
    name: identity.cookieName,
    value: identity.sessionToken,
    url: 'http://127.0.0.1:4173',
    httpOnly: true,
    sameSite: 'Lax',
  }])
}

export function operationId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

export async function api<T>(
  page: Page,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const response = await page.request.fetch(path, {
    method,
    data: body,
    headers: {
      Origin: 'http://127.0.0.1:4173',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
  })
  if (!response.ok()) {
    throw new Error(`${method} ${path} returned ${response.status()}: ${await response.text()}`)
  }
  return response.json() as Promise<T>
}

export async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('Service Worker unavailable')
    await navigator.serviceWorker.ready
  })
  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
    await page.reload()
  }
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
}
