import { describe, expect, it, vi } from 'vitest'
import {
  GeocodingError,
  NominatimReverseGeocoder,
} from '../src/geocoding.js'

function providerResponse(name = 'Ротонда', address = 'Набережная, Ижевск, Россия') {
  return new Response(JSON.stringify({
    name,
    display_name: address,
    address: { road: 'Набережная', city: 'Ижевск' },
    place_id: 123,
    osm_id: 456,
    licence: 'raw provider fields must not escape',
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

function service(fetchImplementation: FetchLike, options: {
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  timeoutMilliseconds?: number
  maximumQueuedRequests?: number
  queueDeadlineMilliseconds?: number
} = {}) {
  return new NominatimReverseGeocoder({
    baseUrl: 'https://nominatim.openstreetmap.org',
    appOrigin: 'https://kabanda.example',
    userAgent: 'KabandaClosedAlpha/test (https://kabanda.example)',
    fetch: fetchImplementation,
    ...options,
  })
}

describe('Nominatim reverse geocoder', () => {
  it('identifies the app, rounds coordinates, caches them and exposes only bounded labels', async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL, _init?: RequestInit) => providerResponse(
      `  ${'Очень длинное имя '.repeat(20)}  `,
      `  ${'Длинный адрес '.repeat(40)}  `,
    ))
    const geocoding = service(fetchImplementation)

    const first = await geocoding.reverse(56.850001, 53.200001)
    const cached = await geocoding.reverse(56.850004, 53.200004)

    expect(cached).toEqual(first)
    expect(first).toEqual({
      name: expect.any(String),
      address: expect.any(String),
      source: 'openstreetmap',
    })
    expect(first.name.length).toBeLessThanOrEqual(160)
    expect(first.address.length).toBeLessThanOrEqual(300)
    expect(first).not.toHaveProperty('place_id')
    expect(fetchImplementation).toHaveBeenCalledOnce()
    const [rawUrl, init] = fetchImplementation.mock.calls[0]!
    const url = new URL(String(rawUrl))
    expect(url.origin + url.pathname).toBe('https://nominatim.openstreetmap.org/reverse')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      format: 'jsonv2',
      lat: '56.85000',
      lon: '53.20000',
      zoom: '18',
      addressdetails: '1',
    })
    const headers = new Headers(init?.headers)
    expect(headers.get('user-agent')).toBe(
      'KabandaClosedAlpha/test (https://kabanda.example)',
    )
    expect(headers.get('referer')).toBe('https://kabanda.example')
    expect(headers.get('accept-language')).toBe('ru')
  })

  it('coalesces identical requests and starts distinct upstream calls at least one second apart', async () => {
    let clock = 0
    const starts: number[] = []
    const sleep = vi.fn(async (milliseconds: number) => {
      clock += milliseconds
    })
    const fetchImplementation = vi.fn(async () => {
      starts.push(clock)
      return providerResponse()
    })
    const geocoding = service(fetchImplementation, { now: () => clock, sleep })

    const [first, coalesced, second, third] = await Promise.all([
      geocoding.reverse(56.81, 53.11),
      geocoding.reverse(56.81, 53.11),
      geocoding.reverse(56.82, 53.12),
      geocoding.reverse(56.83, 53.13),
    ])

    expect(coalesced).toEqual(first)
    expect(second.source).toBe('openstreetmap')
    expect(third.source).toBe('openstreetmap')
    expect(fetchImplementation).toHaveBeenCalledTimes(3)
    expect(starts).toEqual([0, 1_000, 2_000])
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('bounds the queue and rejects work that cannot start before its total deadline', async () => {
    let clock = 0
    const fetchImplementation = vi.fn(async () => providerResponse())
    const geocoding = service(fetchImplementation, {
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds },
      maximumQueuedRequests: 3,
      queueDeadlineMilliseconds: 1_500,
    })

    const results = await Promise.allSettled([
      geocoding.reverse(56.81, 53.11),
      geocoding.reverse(56.82, 53.12),
      geocoding.reverse(56.83, 53.13),
    ])

    expect(results[0]?.status).toBe('fulfilled')
    expect(results[1]?.status).toBe('fulfilled')
    expect(results[2]).toMatchObject({
      status: 'rejected',
      reason: {
        code: 'GEOCODING_PROVIDER_UNAVAILABLE',
        statusCode: 503,
      },
    })
    expect(fetchImplementation).toHaveBeenCalledTimes(2)

    const saturated = service(vi.fn(async () => new Promise<Response>(() => {})), {
      maximumQueuedRequests: 1,
      queueDeadlineMilliseconds: 50,
    })
    void saturated.reverse(56.84, 53.14).catch(() => undefined)
    await expect(saturated.reverse(56.85, 53.15)).rejects.toMatchObject({
      code: 'GEOCODING_PROVIDER_UNAVAILABLE',
      statusCode: 503,
    })
  })

  it('maps provider, payload and timeout failures to the typed 503', async () => {
    const failed = service(vi.fn(async () => new Response('busy', { status: 503 })))
    await expect(failed.reverse(56.85, 53.2)).rejects.toMatchObject({
      code: 'GEOCODING_PROVIDER_UNAVAILABLE',
      statusCode: 503,
    })

    const invalid = service(vi.fn(async () => new Response('{not-json', { status: 200 })))
    await expect(invalid.reverse(56.85, 53.2)).rejects.toBeInstanceOf(GeocodingError)

    const timedOut = service(
      vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })),
      { timeoutMilliseconds: 5 },
    )
    await expect(timedOut.reverse(56.85, 53.2)).rejects.toMatchObject({
      code: 'GEOCODING_PROVIDER_UNAVAILABLE',
      statusCode: 503,
    })
  })
})
