import type { ReverseGeocodeResult } from '@kabanda/contracts'

export class GeocodingError extends Error {
  constructor(
    readonly code: 'GEOCODING_PROVIDER_UNAVAILABLE',
    readonly statusCode: 503,
    message: string,
  ) {
    super(message)
  }
}

export interface GeocodingService {
  reverse(latitude: number, longitude: number): Promise<ReverseGeocodeResult>
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

type NominatimReverseGeocoderOptions = {
  baseUrl: string
  appOrigin: string
  userAgent: string
  fetch?: FetchLike
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  timeoutMilliseconds?: number
  cacheTtlMilliseconds?: number
  maximumCacheEntries?: number
  maximumQueuedRequests?: number
  queueDeadlineMilliseconds?: number
}

type CacheEntry = {
  expiresAt: number
  result: ReverseGeocodeResult
}

const upstreamIntervalMilliseconds = 1_000
const maximumUpstreamBodyBytes = 64 * 1024

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function boundedText(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, maximumLength)
}

function firstBoundedValue(
  record: Record<string, unknown>,
  keys: string[],
  maximumLength: number,
): string {
  for (const key of keys) {
    const candidate = boundedText(record[key], maximumLength)
    if (candidate) return candidate
  }
  return ''
}

function providerUnavailable(): GeocodingError {
  return new GeocodingError(
    'GEOCODING_PROVIDER_UNAVAILABLE',
    503,
    'Не удалось определить адрес. Введите его вручную',
  )
}

export class NominatimReverseGeocoder implements GeocodingService {
  private readonly fetchImplementation: FetchLike
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly timeoutMilliseconds: number
  private readonly cacheTtlMilliseconds: number
  private readonly maximumCacheEntries: number
  private readonly maximumQueuedRequests: number
  private readonly queueDeadlineMilliseconds: number
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<ReverseGeocodeResult>>()
  private upstreamQueue: Promise<void> = Promise.resolve()
  private nextUpstreamAt = 0
  private queuedRequests = 0

  constructor(private readonly options: NominatimReverseGeocoderOptions) {
    this.fetchImplementation = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? delay
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 4_000
    this.cacheTtlMilliseconds = options.cacheTtlMilliseconds ?? 24 * 60 * 60 * 1_000
    this.maximumCacheEntries = options.maximumCacheEntries ?? 500
    this.maximumQueuedRequests = options.maximumQueuedRequests ?? 6
    this.queueDeadlineMilliseconds = options.queueDeadlineMilliseconds ?? 6_000
  }

  async reverse(latitude: number, longitude: number): Promise<ReverseGeocodeResult> {
    const roundedLatitude = Number(latitude.toFixed(5))
    const roundedLongitude = Number(longitude.toFixed(5))
    const cacheKey = `${roundedLatitude.toFixed(5)},${roundedLongitude.toFixed(5)}`
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > this.now()) {
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached)
      return cached.result
    }
    if (cached) this.cache.delete(cacheKey)

    const active = this.inflight.get(cacheKey)
    if (active) return active
    if (this.queuedRequests >= this.maximumQueuedRequests) throw providerUnavailable()

    this.queuedRequests += 1
    const deadline = this.now() + this.queueDeadlineMilliseconds
    const request = this.enqueueUpstream(roundedLatitude, roundedLongitude, deadline)
      .then((result) => {
        this.storeCache(cacheKey, result)
        return result
      })
      .finally(() => {
        this.queuedRequests -= 1
        this.inflight.delete(cacheKey)
      })
    this.inflight.set(cacheKey, request)
    return request
  }

  private enqueueUpstream(
    latitude: number,
    longitude: number,
    deadline: number,
  ): Promise<ReverseGeocodeResult> {
    const request = this.upstreamQueue.then(async () => {
      const remainingMilliseconds = deadline - this.now()
      if (remainingMilliseconds <= 0) throw providerUnavailable()
      const waitMilliseconds = Math.max(0, this.nextUpstreamAt - this.now())
      if (waitMilliseconds >= remainingMilliseconds) throw providerUnavailable()
      if (waitMilliseconds > 0) await this.sleep(waitMilliseconds)
      if (this.now() >= deadline) throw providerUnavailable()
      this.nextUpstreamAt = this.now() + upstreamIntervalMilliseconds
      return this.requestUpstream(latitude, longitude, deadline)
    })
    this.upstreamQueue = request.then(() => undefined, () => undefined)
    return request
  }

  private async requestUpstream(
    latitude: number,
    longitude: number,
    deadline: number,
  ): Promise<ReverseGeocodeResult> {
    const baseUrl = this.options.baseUrl.endsWith('/')
      ? this.options.baseUrl
      : `${this.options.baseUrl}/`
    const url = new URL('reverse', baseUrl)
    url.searchParams.set('format', 'jsonv2')
    url.searchParams.set('lat', latitude.toFixed(5))
    url.searchParams.set('lon', longitude.toFixed(5))
    url.searchParams.set('zoom', '18')
    url.searchParams.set('addressdetails', '1')

    const remainingMilliseconds = deadline - this.now()
    if (remainingMilliseconds <= 0) throw providerUnavailable()
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(this.timeoutMilliseconds, remainingMilliseconds),
    )
    try {
      const response = await this.fetchImplementation(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'ru',
          Referer: this.options.appOrigin,
          'User-Agent': this.options.userAgent,
        },
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) throw providerUnavailable()
      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > maximumUpstreamBodyBytes) {
        throw providerUnavailable()
      }
      const responseText = await response.text()
      if (Buffer.byteLength(responseText, 'utf8') > maximumUpstreamBodyBytes) {
        throw providerUnavailable()
      }
      return this.normalizeResponse(responseText)
    } catch (error) {
      if (error instanceof GeocodingError) throw error
      throw providerUnavailable()
    } finally {
      clearTimeout(timeout)
    }
  }

  private normalizeResponse(responseText: string): ReverseGeocodeResult {
    let value: unknown
    try {
      value = JSON.parse(responseText)
    } catch {
      throw providerUnavailable()
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw providerUnavailable()
    const response = value as Record<string, unknown>
    if ('error' in response) throw providerUnavailable()
    const addressParts = response.address && typeof response.address === 'object'
      && !Array.isArray(response.address)
      ? response.address as Record<string, unknown>
      : {}
    const address = boundedText(response.display_name, 300)
    if (!address) throw providerUnavailable()
    const name = boundedText(response.name, 160) || firstBoundedValue(addressParts, [
      'amenity',
      'shop',
      'tourism',
      'leisure',
      'building',
      'road',
      'pedestrian',
      'neighbourhood',
      'suburb',
    ], 160)
    return { name, address, source: 'openstreetmap' }
  }

  private storeCache(cacheKey: string, result: ReverseGeocodeResult): void {
    while (this.cache.size >= this.maximumCacheEntries) {
      const oldestKey = this.cache.keys().next().value
      if (typeof oldestKey !== 'string') break
      this.cache.delete(oldestKey)
    }
    this.cache.set(cacheKey, {
      expiresAt: this.now() + this.cacheTtlMilliseconds,
      result,
    })
  }
}
