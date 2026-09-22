import { expect, test, type Page } from '@playwright/test'
import type { RaidProjection } from '../apps/pwa/src/features/raids/types.js'

type Observation = { id: number; kind: string; coordinate: number[] }
type LineObservation = { id: number; part: string; coordinates: number[][]; marker: number[] | null }
type Evidence = {
  markers: Observation[]; cameras: number[][]; moveViewer: (meters: number) => void
  lines: LineObservation[]; activePreviews: number; canonicalWrites: number; lastNavigator: number[] | null
}
const viewerId = '11111111-1111-4111-8111-111111111111'
const navigatorId = '22222222-2222-4222-8222-222222222222'
const teamId = '33333333-3333-4333-8333-333333333333'
const raidId = '44444444-4444-4444-8444-444444444444'
const originLatitude = 56.86
const navigatorLatitude = 56.863
const raid: RaidProjection = {
  id: raidId, kabandaId: teamId, title: 'Плавное движение', state: 'active', version: 3,
  scheduledAt: null, description: null, organizerUserId: navigatorId, navigatorUserId: navigatorId,
  navigatorReady: true, navigatorBlockers: [], navigatorWarnings: [], navigatorLease: null, finalization: null,
  participants: [viewerId, navigatorId].map((id, index) => ({ id, displayName: `Участник ${index + 1}`, avatarUrl: null, state: 'active' })),
  allowedActions: [], routeStatus: { status: 'awaiting_lease', acceptedSampleCount: 0, missingSequenceCount: 0, lastSampleAt: null, lastReceivedAt: null },
}

test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference', serviceWorkers: 'block' })

async function prepare(page: Page, withRoutePreview = false) {
  // Instrument the provider boundary, not the animator: the real component,
  // RAF, visibility/media-query hooks and source timestamps remain in use.
  await page.addInitScript(() => {
    const evidence: Evidence = { markers: [], cameras: [], moveViewer: () => {},
      lines: [], activePreviews: 0, canonicalWrites: 0, lastNavigator: null }
    const scope = window as unknown as { ymaps: unknown; __motionEvidence: Evidence }
    scope.__motionEvidence = evidence
    let sequence = 0
    class Placemark {
      id = ++sequence
      element: HTMLElement | null = null
      coordinate: readonly number[]
      values: Record<string, unknown>
      geometry = { setCoordinates: (coordinate: readonly number[]) => {
        this.coordinate = [...coordinate]
        if (String(this.values.markerClass).includes('route-live-map__rider')) {
          evidence.markers.push({ id: this.id, kind: String(this.values.markerClass), coordinate: [...coordinate] })
          if (String(this.values.markerClass).includes('--navigator')) evidence.lastNavigator = [...coordinate]
        }
      } }
      properties = { set: (key: string, value: unknown) => { this.values[key] = value; this.sync() } }
      options = { set: () => {} }
      events = { add: () => {}, remove: () => {} }
      constructor(coordinate: readonly number[], values: Record<string, unknown> = {}) { this.coordinate = coordinate; this.values = values }
      sync() {
        if (!this.element) return
        this.element.className = String(this.values.markerClass ?? '')
        this.element.setAttribute('role', 'img')
        this.element.setAttribute('aria-label', String(this.values.label ?? this.values.ariaLabel ?? ''))
      }
    }
    class Polyline {
      id = ++sequence
      element: HTMLElement | null = null
      geometry = { setCoordinates: (coordinates: readonly (readonly number[])[]) => this.observe(coordinates) }
      constructor(coordinates: readonly (readonly number[])[], readonly values: Record<string, unknown> = {}) { this.observe(coordinates) }
      sync() {}
      private observe(coordinates: readonly (readonly number[])[]) {
        if (this.values.routePreview === true) evidence.lines.push({ id: this.id, part: String(this.values.routePreviewPart),
          coordinates: coordinates.map(point => [...point]), marker: evidence.lastNavigator ? [...evidence.lastNavigator] : null })
        else evidence.canonicalWrites++
      }
    }
    class MapView {
      center: readonly number[]; zoom: number
      objects = new Set<Placemark | Polyline>()
      events = { add: () => {}, remove: () => {} }
      geoObjects = {
        add: (object: Placemark | Polyline) => {
          if (this.objects.has(object)) return
          this.objects.add(object)
          if (object instanceof Polyline && object.values.routePreview === true) evidence.activePreviews++
          object.element = document.createElement('span'); object.sync(); this.container.append(object.element)
        },
        remove: (object: Placemark | Polyline) => {
          if (!this.objects.delete(object)) return
          if (object instanceof Polyline && object.values.routePreview === true) evidence.activePreviews--
          object.element?.remove()
        },
      }
      constructor(private container: HTMLElement, state: { center: readonly number[]; zoom: number }) { this.center = state.center; this.zoom = state.zoom }
      getCenter() { return this.center }
      getZoom() { return this.zoom }
      setCenter(coordinate: readonly number[], zoom = this.zoom) { this.center = [...coordinate]; this.zoom = zoom; evidence.cameras.push([...coordinate]) }
      setZoom(zoom: number) { this.zoom = zoom }
      destroy() { for (const object of [...this.objects]) this.geoObjects.remove(object) }
    }
    scope.ymaps = { ready: (callback: () => void) => callback(), Map: MapView, Placemark,
      Polyline, templateLayoutFactory: { createClass: (template: string) => template } }
    let latitude = 56.86, watcherId = 0
    const watchers = new Map<number, PositionCallback>()
    const position = (): GeolocationPosition => ({ timestamp: Date.now(), coords: {
      latitude, longitude: 53.21, accuracy: 8, altitude: null, altitudeAccuracy: null, heading: null, speed: 5,
      toJSON: () => ({}),
    }, toJSON: () => ({}) })
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition: (callback: PositionCallback) => callback(position()),
      watchPosition: (callback: PositionCallback) => { watchers.set(++watcherId, callback); queueMicrotask(() => callback(position())); return watcherId },
      clearWatch: (id: number) => watchers.delete(id),
    } })
    evidence.moveViewer = meters => { latitude = 56.86 + meters / 111195; for (const callback of watchers.values()) callback(position()) }
  })
  let offset = 0
  const initialTime = Date.now() - 3000
  let observedAt = initialTime
  let scenarioRaid: RaidProjection = withRoutePreview ? { ...raid,
    navigatorLease: { id: '55555555-5555-4555-8555-555555555555', generation: 1, issuedAt: new Date(initialTime - 60_000).toISOString() },
    routeStatus: { ...raid.routeStatus, status: 'fresh', acceptedSampleCount: 2,
      lastSampleAt: new Date(initialTime).toISOString(), lastReceivedAt: new Date(initialTime).toISOString() },
  } : raid
  let canonical = withRoutePreview ? [
    { latitude: navigatorLatitude - 60 / 111195, longitude: 53.21, capturedAt: new Date(initialTime - 1000).toISOString() },
    { latitude: navigatorLatitude, longitude: 53.21, capturedAt: new Date(initialTime).toISOString() },
  ] : []
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname, now = new Date().toISOString()
    const body = path === '/api/me' ? { user: { id: viewerId, displayName: 'Участник', username: 'motion-qa', email: 'motion@example.test', identityKind: 'verified', avatarUrl: null } }
      : path === '/api/kabandas' ? { kabandas: [{ id: teamId, name: 'Плавное движение', role: 'member', avatar: '🐗', coverImage: null, memberCount: 2, pointsCollectionId: null }] }
      : path.endsWith('/live') ? { raid: scenarioRaid, teamVisits: true, fieldVisible: true, revision: '1', points: [], claims: [], fallbacks: [],
          positions: [{ userId: navigatorId, latitude: navigatorLatitude + offset / 111195, longitude: 53.21, accuracyMeters: 8, capturedAt: new Date(observedAt).toISOString() }],
          // Keep the drawn server route deliberately frozen while presence moves.
          track: { segments: canonical.length ? [canonical] : [], pointCount: canonical.length, truncated: false,
            updatedAt: canonical.at(-1)?.capturedAt ?? null, serverAt: now } }
      : path.endsWith('/check-ins/nearby') ? { policy: { version: 'v1', radiusMeters: 50, maxAgeSeconds: 60, maxAccuracyMeters: 50 }, points: [] }
      : path.endsWith('/presence/me') ? { radiusMeters: 50, maxAgeSeconds: 30, allReady: false, participants: [], serverAt: now }
      : path.endsWith('/media') ? { media: [], nextCursor: null }
      : path.endsWith('/raids') ? { raids: [scenarioRaid] }
      : path.endsWith('/raids/history/page') ? { schemaVersion: 2, scope: url.searchParams.get('scope') ?? 'all', raids: [], nextCursor: null }
      : path.includes('templates') ? { templates: [], nextCursor: null }
      : path.endsWith('/members') ? { members: raid.participants.map(person => ({ ...person, role: 'member' })) }
      : path.endsWith('/progress') ? { progress: { personal: { durationSeconds: 0, distanceMeters: 0, uniquePoints: 0, photos: 0, completedRaids: 0 }, team: { durationSeconds: 0, distanceMeters: 0, uniquePoints: 0, photos: 0, completedRaids: 0 } } }
      : path === `/api/raids/${raidId}` ? { raid: scenarioRaid } : {}
    await route.fulfill({ json: body })
  })
  await page.goto(`/app?raid=${raidId}`)
  await expect(page.getByRole('img', { name: 'Навигатор', exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Моё положение', exact: true })).toBeVisible()
  if (withRoutePreview) await expect.poll(async () => (await read(page)).canonicalWrites).toBeGreaterThan(0)
  return {
    moveNavigator: (meters: number) => { offset = meters; observedAt = withRoutePreview ? Date.now() : observedAt + 2000 },
    confirmTrack: () => {
      canonical = [...canonical, { latitude: navigatorLatitude + offset / 111195, longitude: 53.21, capturedAt: new Date(observedAt).toISOString() }]
      scenarioRaid = { ...scenarioRaid, routeStatus: { ...scenarioRaid.routeStatus,
        lastSampleAt: new Date(observedAt).toISOString(), acceptedSampleCount: canonical.length } }
    },
  }
}
const read = (page: Page) => page.evaluate(() => {
  const data = (window as unknown as { __motionEvidence: Evidence }).__motionEvidence
  return { markers: data.markers, cameras: data.cameras, lines: data.lines, activePreviews: data.activePreviews, canonicalWrites: data.canonicalWrites }
})
const clear = (page: Page) => page.evaluate(() => {
  const data = (window as unknown as { __motionEvidence: Evidence }).__motionEvidence
  data.markers = []; data.cameras = []; data.lines = []; data.canonicalWrites = 0
})

test('navigator receives intermediate positions on one existing marker without extrapolation', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const controls = await prepare(page)
  await clear(page)
  controls.moveNavigator(60)
  await expect.poll(async () => (await read(page)).markers.filter(item => item.kind.includes('--navigator')).at(-1)?.coordinate[0]).toBeCloseTo(navigatorLatitude + 60 / 111195, 8)
  const points = (await read(page)).markers.filter(item => item.kind.includes('--navigator'))
  const intermediate = points.filter(item => item.coordinate[0]! > navigatorLatitude + 1e-8 && item.coordinate[0]! < navigatorLatitude + 60 / 111195 - 1e-8)
  expect(intermediate.length).toBeGreaterThan(3)
  expect(new Set(points.map(item => item.id)).size).toBe(1)
  for (let index = 1; index < points.length; index++) expect(points[index]!.coordinate[0]!).toBeGreaterThanOrEqual(points[index - 1]!.coordinate[0]! - 1e-10)
  expect(points.every(item => item.coordinate[0]! <= navigatorLatitude + 60 / 111195 + 1e-10)).toBe(true)
  expect(errors).toEqual([])
})

test('reduced motion places the received position without intermediate animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const controls = await prepare(page)
  await clear(page); controls.moveNavigator(60)
  await expect.poll(async () => (await read(page)).markers.filter(item => item.kind.includes('--navigator')).at(-1)?.coordinate[0]).toBeCloseTo(navigatorLatitude + 60 / 111195, 8)
  const points = (await read(page)).markers.filter(item => item.kind.includes('--navigator'))
  expect(points.every(item => Math.abs(item.coordinate[0]! - navigatorLatitude) < 1e-10 || Math.abs(item.coordinate[0]! - navigatorLatitude - 60 / 111195) < 1e-10)).toBe(true)
})

test('follow camera uses the displayed position and yields immediately to a manual map gesture', async ({ page }) => {
  await prepare(page)
  const follow = page.getByRole('button', { name: 'Показать моё местоположение', exact: true })
  await follow.click(); await expect(follow).toHaveAttribute('aria-pressed', 'true')
  await clear(page)
  await page.evaluate(() => (window as unknown as { __motionEvidence: Evidence }).__motionEvidence.moveViewer(60))
  await expect.poll(async () => (await read(page)).markers.filter(item => item.kind.includes('--participant')).at(-1)?.coordinate[0]).toBeCloseTo(originLatitude + 60 / 111195, 8)
  const data = await read(page)
  const intermediate = data.markers.filter(item => item.kind.includes('--participant') && item.coordinate[0]! > originLatitude + 1e-8 && item.coordinate[0]! < originLatitude + 60 / 111195 - 1e-8)
  expect(intermediate.length).toBeGreaterThan(3)
  for (const item of intermediate) expect(data.cameras.some(coordinate => Math.abs(coordinate[0]! - item.coordinate[0]!) < 1e-10)).toBe(true)
  await page.locator('.route-live-map').dispatchEvent('wheel', { deltaY: 10 })
  await expect(follow).toHaveAttribute('aria-pressed', 'false')
  await clear(page)
  await page.evaluate(() => (window as unknown as { __motionEvidence: Evidence }).__motionEvidence.moveViewer(120))
  await expect.poll(async () => (await read(page)).markers.filter(item => item.kind.includes('--participant')).at(-1)?.coordinate[0]).toBeCloseTo(originLatitude + 120 / 111195, 8)
  expect((await read(page)).cameras).toEqual([])
})


test('route tail follows every rendered navigator frame while the canonical route is delayed', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const controls = await prepare(page, true)
  await clear(page); controls.moveNavigator(60)
  await expect.poll(async () => (await read(page)).markers.filter(item => item.kind.includes('--navigator')).at(-1)?.coordinate[0])
    .toBeCloseTo(navigatorLatitude + 60 / 111195, 8)
  const data = await read(page)
  const moving = data.lines.filter(line => line.part === 'tip' && line.coordinates.at(-1)![0]! > navigatorLatitude + 1e-8 &&
    line.coordinates.at(-1)![0]! < navigatorLatitude + 60 / 111195 - 1e-8)
  expect(moving.length).toBeGreaterThan(3)
  for (const line of moving) {
    expect(line.coordinates).toHaveLength(2)
    expect(line.marker).not.toBeNull()
    expect(line.coordinates.at(-1)![0]).toBeCloseTo(line.marker![0]!, 10)
    expect(line.coordinates.at(-1)![1]).toBeCloseTo(line.marker![1]!, 10)
  }
  expect(data.canonicalWrites).toBe(0)
  expect(new Set(moving.map(line => line.id)).size).toBe(2) // casing and stroke, not a new object per frame
  expect(errors).toEqual([])
})

test('a canonical catch-up retires the live route tail without another GPS fix', async ({ page }) => {
  const controls = await prepare(page, true)
  await clear(page); controls.moveNavigator(60)
  await expect.poll(async () => (await read(page)).markers.filter(item => item.kind.includes('--navigator')).at(-1)?.coordinate[0])
    .toBeCloseTo(navigatorLatitude + 60 / 111195, 8)
  expect((await read(page)).activePreviews).toBeGreaterThan(0)
  await clear(page); controls.confirmTrack()
  await expect.poll(async () => (await read(page)).activePreviews).toBe(0)
  expect((await read(page)).canonicalWrites).toBeGreaterThan(0)
})

test('reduced motion draws the live route tail directly without intermediate coordinates', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const controls = await prepare(page, true)
  await clear(page); controls.moveNavigator(60)
  await expect.poll(async () => (await read(page)).markers.filter(item => item.kind.includes('--navigator')).at(-1)?.coordinate[0])
    .toBeCloseTo(navigatorLatitude + 60 / 111195, 8)
  const tips = (await read(page)).lines.filter(line => line.part === 'tip')
  expect(tips.length).toBeGreaterThan(0)
  for (const line of tips) expect(line.coordinates.at(-1)![0]).toBeCloseTo(navigatorLatitude + 60 / 111195, 10)
})

test('moving a participant does not extend the navigator route to that participant', async ({ page }) => {
  await prepare(page, true)
  await clear(page)
  await page.evaluate(() => (window as unknown as { __motionEvidence: Evidence }).__motionEvidence.moveViewer(60))
  await expect.poll(async () => (await read(page)).markers.filter(item => item.kind.includes('--participant')).at(-1)?.coordinate[0])
    .toBeCloseTo(originLatitude + 60 / 111195, 8)
  const data = await read(page)
  expect(data.activePreviews).toBe(0)
  expect(data.lines).toEqual([])
  expect(data.canonicalWrites).toBe(0)
})
