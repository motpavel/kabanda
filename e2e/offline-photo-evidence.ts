import type { BrowserContext, Page, TestInfo } from '@playwright/test'

/** Observes the synthetic PNG fixture only. Native implementations and their
 * errors are returned unchanged; no decoder, network or IDB result is mocked. */
export async function observePhotoPreparation(context: BrowserContext) {
  await context.addInitScript(() => {
    const steps: string[] = []
    Object.assign(window, { offlinePhotoSteps: steps })
    const errorName = (error: unknown) => error instanceof Error ? `${error.name}:${error.message}` : String(error)
    if (typeof createImageBitmap === 'function') {
      const original = window.createImageBitmap.bind(window)
      window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
        steps.push('bitmap:start')
        return original(...args).then(value => { steps.push('bitmap:ok'); return value }, error => {
          steps.push(`bitmap:${errorName(error)}`); throw error
        })
      }) as typeof createImageBitmap
    }
    const read = FileReader.prototype.readAsDataURL
    FileReader.prototype.readAsDataURL = function (file) {
      steps.push(`reader:start:${file.type}:${file.size}`)
      this.addEventListener('loadend', () => steps.push(this.error ? `reader:${errorName(this.error)}`
        : `reader:ok:${typeof this.result === 'string' ? this.result.slice(0, 32) : typeof this.result}`), { once: true })
      return read.call(this, file)
    }
    const buffer = Blob.prototype.arrayBuffer
    Blob.prototype.arrayBuffer = function () {
      return buffer.call(this).then(value => { steps.push(`buffer:ok:${value.byteLength}`); return value }, error => {
        steps.push(`buffer:${errorName(error)}`); throw error
      })
    }
    document.addEventListener('change', event => {
      const input = event.target
      if (input instanceof HTMLInputElement && input.type === 'file' && input.files?.length) {
        Object.assign(window, { offlineSelectedPhoto: input.files[0] })
        steps.push(`selected:${input.files[0]!.type}:${input.files[0]!.size}`)
      }
    }, true)
  })
}

export async function attachOfflinePhotoEvidence(page: Page, info: TestInfo) {
  const data = await page.evaluate(async () => {
    const view = window as unknown as { offlinePhotoSteps?: string[]; offlineSelectedPhoto?: File }
    const selected = view.offlineSelectedPhoto
    let read: number | string = 'no fixture file selected'
    if (selected) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        read = await Promise.race([selected.arrayBuffer().then(bytes => bytes.byteLength),
          new Promise<string>(resolve => { timer = setTimeout(() => resolve('native read timed out'), 2000) })])
      } catch (error) { read = error instanceof Error ? `${error.name}:${error.message}` : String(error) }
      finally { clearTimeout(timer) }
    }
    return { online: navigator.onLine, steps: view.offlinePhotoSteps ?? [], nativeFileRead: read,
      fixtureType: selected?.type, fixtureSize: selected?.size,
      message: document.querySelector('.checkin-panel [role="status"]')?.textContent ?? null }
  })
  await info.attach('offline-native-photo-evidence', { body: JSON.stringify(data), contentType: 'application/json' })
}
