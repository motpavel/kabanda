import { describe, expect, it } from 'vitest'
import { yandexMapsApiUrl } from './yandex-maps'

describe('yandexMapsApiUrl', () => {
  it('builds a Russian JavaScript API v3 URL and safely encodes the browser key', () => {
    const url = new URL(yandexMapsApiUrl(' test+key '))

    expect(url.origin).toBe('https://api-maps.yandex.ru')
    expect(url.pathname).toBe('/v3/')
    expect(url.searchParams.get('apikey')).toBe('test+key')
    expect(url.searchParams.get('lang')).toBe('ru_RU')
  })
})
