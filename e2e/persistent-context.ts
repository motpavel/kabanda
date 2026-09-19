import type { Browser, BrowserContext, BrowserContextOptions, TestInfo } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Installed/offline PWA behavior requires a normal persistent WebKit profile,
 * not a private ephemeral store. Each simulated phone gets its own NEW profile.
 * The profile contains only disposable test identities and is removed on close. */
export async function createDeviceContext(browser: Browser, options: BrowserContextOptions): Promise<BrowserContext> {
  if (browser.browserType().name() !== 'webkit') return browser.newContext(options)
  const directory = await mkdtemp(join(tmpdir(), 'kabanda-webkit-device-'))
  try {
    const context = await browser.browserType().launchPersistentContext(directory, { ...options, headless: true })
    const close = context.close.bind(context)
    context.close = async closeOptions => {
      try { await close(closeOptions) }
      finally { await rm(directory, { recursive: true, force: true }) }
    }
    return context
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
}

export async function captureDeviceTrace(context: BrowserContext, info: TestInfo, name: string) {
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  return async () => {
    if (info.status !== info.expectedStatus) {
      const path = info.outputPath(`${name}.zip`)
      await context.tracing.stop({ path })
      await info.attach(name, { path, contentType: 'application/zip' })
    } else await context.tracing.stop()
  }
}
