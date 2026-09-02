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

export async function installYandexMapsMock(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    type MapEvent = { get: (name: string) => unknown }
    type MapHandler = (event: MapEvent) => void
    type PlacemarkHandler = (event: { stopPropagation: () => void }) => void
    type MockMapObject = MockPlacemark | MockPolyline

    class MockPlacemark {
      element: HTMLElement | null = null
      readonly values: Record<string, unknown>
      readonly settings: Record<string, unknown>
      readonly handlers: Record<string, PlacemarkHandler[]> = {}
      readonly properties = {
        set: (name: string, value: unknown) => {
          this.values[name] = value
          this.syncElement()
        },
      }
      readonly options = {
        set: (name: string, value: unknown) => {
          this.settings[name] = value
        },
      }
      readonly events = {
        add: (name: string, handler: PlacemarkHandler) => {
          this.handlers[name] = [...(this.handlers[name] ?? []), handler]
        },
      }

      constructor(
        readonly coordinates: readonly [number, number],
        properties: Record<string, unknown> = {},
        options: Record<string, unknown> = {},
      ) {
        this.values = { ...properties }
        this.settings = { ...options }
      }

      syncElement() {
        if (!this.element) return
        const markerClass = this.values.markerClass
        if (typeof markerClass === 'string') this.element.className = markerClass
        const ariaLabel = this.values.ariaLabel
        if (typeof ariaLabel === 'string') this.element.setAttribute('aria-label', ariaLabel)
        const selected = this.values.selected
        if (typeof selected === 'string') this.element.setAttribute('aria-pressed', selected)
      }
    }

    class MockPolyline {
      element: HTMLElement | null = null
      private coordinates: readonly (readonly [number, number])[]
      readonly settings: Record<string, unknown>
      readonly geometry = {
        getCoordinates: () => this.coordinates,
        setCoordinates: (coordinates: readonly (readonly [number, number])[]) => {
          this.coordinates = coordinates
        },
      }

      constructor(
        coordinates: readonly (readonly [number, number])[],
        _properties: Record<string, unknown> = {},
        options: Record<string, unknown> = {},
      ) {
        this.coordinates = coordinates
        this.settings = { ...options }
      }
    }

    class MockYandexMap {
      private center: readonly [number, number]
      private zoom: number
      private readonly handlers: Record<string, MapHandler[]> = {}
      private readonly objects = new Set<MockMapObject>()
      readonly events = {
        add: (name: string, handler: MapHandler) => {
          this.handlers[name] = [...(this.handlers[name] ?? []), handler]
        },
      }
      readonly geoObjects = {
        add: (object: MockMapObject) => {
          this.objects.add(object)
          if (object instanceof MockPolyline) {
            const element = document.createElement('span')
            element.dataset.yandexPolyline = 'true'
            const strokeColor = object.settings.strokeColor
            if (typeof strokeColor === 'string') element.dataset.strokeColor = strokeColor
            object.element = element
            this.container.append(element)
            return
          }
          const placemark = object
          const markerClass = placemark.values.markerClass
          const iconLayout = placemark.settings.iconLayout
          const rider = typeof iconLayout === 'string' && iconLayout.includes('route-live-map__rider')
          const element = document.createElement(typeof markerClass === 'string' ? 'button' : 'span')
          if (element instanceof HTMLButtonElement) element.type = 'button'
          if (typeof markerClass !== 'string') {
            element.className = rider ? 'route-live-map__rider' : 'kb-yandex-user-location'
            element.setAttribute('aria-label', rider ? 'Положение навигатора рейда' : 'Моё местоположение')
          }
          placemark.element = element
          placemark.syncElement()
          element.addEventListener('click', (event) => {
            for (const handler of placemark.handlers.click ?? []) {
              handler({ stopPropagation: () => event.stopPropagation() })
            }
          })
          this.container.append(element)
        },
        remove: (object: MockMapObject) => {
          this.objects.delete(object)
          object.element?.remove()
          object.element = null
        },
      }

      constructor(
        private readonly container: HTMLElement,
        state: { center: readonly [number, number]; zoom: number },
      ) {
        this.center = state.center
        this.zoom = state.zoom
      }

      private emitBoundsChange() {
        const event: MapEvent = {
          get: (name) => name === 'newCenter' ? this.center : name === 'newZoom' ? this.zoom : undefined,
        }
        for (const handler of this.handlers.boundschange ?? []) handler(event)
      }

      getCenter() { return this.center }
      getZoom() { return this.zoom }
      setCenter(center: readonly [number, number], zoom = this.zoom) {
        this.center = center
        this.zoom = zoom
        this.emitBoundsChange()
      }
      setZoom(zoom: number) {
        this.zoom = zoom
        this.emitBoundsChange()
      }
      destroy() {
        for (const object of this.objects) object.element?.remove()
        this.objects.clear()
      }
    }

    const ymaps = {
      ready: (success: () => void) => success(),
      Map: MockYandexMap,
      Placemark: MockPlacemark,
      Polyline: MockPolyline,
      templateLayoutFactory: { createClass: (template: string) => template },
    }
    ;(window as unknown as { ymaps: typeof ymaps }).ymaps = ymaps
  })
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
