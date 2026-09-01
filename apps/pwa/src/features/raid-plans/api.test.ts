import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRaidTemplate, reverseGeocodeTemplatePoint } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('raid template API', () => {
  it('saves only through the template endpoint with a stable idempotency key', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      receipt: { operationId: 'op', command: 'create-raid-template', resultingVersion: 1, serverAt: '2026-09-01T10:00:00.000Z' },
      template: {},
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await createRaidTemplate('kabanda-1', {
      scope: 'all_authenticated',
      title: 'Центр',
      coverImage: 'data:image/jpeg;base64,cover',
      points: [
        { name: 'A', address: 'A', comment: '', latitude: 56.8, longitude: 53.2 },
        { name: 'B', address: 'B', comment: '', latitude: 56.9, longitude: 53.3 },
      ],
    }, 'stable-key')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/kabandas/kabanda-1/raid-templates')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('stable-key')
    expect(String(url)).not.toMatch(/\/raids(?:\/|$)/)
    expect(JSON.parse(String(init?.body))).toMatchObject({ scope: 'all_authenticated', title: 'Центр' })
  })

  it('uses the authenticated reverse-geocode proxy instead of a browser provider call', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
      name: 'Набережная',
      address: 'Ижевск, набережная Зодчего Дудина',
      source: 'openstreetmap',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(reverseGeocodeTemplatePoint(56.8528, 53.2045)).resolves.toMatchObject({ source: 'openstreetmap' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/geocoding/reverse?latitude=56.8528&longitude=53.2045')
  })
})
