import { afterEach, expect, it, vi } from 'vitest'
import { DecodedTiles } from './decoded-tiles'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
function fixture(budget = 100) {
  let serial = 0
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:prepared-${++serial}`)
  const decode = vi.fn(async () => {})
  vi.stubGlobal('Image', class { src = ''; naturalWidth = 4; naturalHeight = 4; decode = decode })
  const fetcher = vi.fn(async () => new Response('png', { headers: { 'content-type': 'image/png', 'X-Kabanda-Tile-Expires': String(Date.now() + 60_000) } }))
  vi.stubGlobal('fetch', fetcher)
  return { pool: new DecodedTiles(budget), revoke, decode, fetcher, signal: new AbortController().signal }
}
it('reuses a decoded image without another fetch or decode', async () => {
  const f = fixture()
  expect(f.pool.url('/tile?scale=2')).toBe('/tile?scale=2')
  await f.pool.prepare('/tile?scale=2', f.signal)
  expect(f.pool.url('/tile?scale=2')).toBe('blob:prepared-1')
  await f.pool.prepare('/tile?scale=2', f.signal)
  expect(f.fetcher).toHaveBeenCalledTimes(1)
  expect(f.decode).toHaveBeenCalledTimes(1)
  f.pool.dispose()
  expect(f.revoke).toHaveBeenCalledWith('blob:prepared-1')
})
it('evicts least recently used decoded bytes and revokes URLs', async () => {
  const f = fixture(140)
  await f.pool.prepare('/a', f.signal); await f.pool.prepare('/b', f.signal)
  f.pool.url('/a')
  await f.pool.prepare('/c', f.signal)
  expect(f.pool.url('/b')).toBe('/b')
  expect(f.pool.url('/a')).toBe('blob:prepared-1')
  expect(f.revoke).toHaveBeenCalledWith('blob:prepared-2')
  f.pool.dispose()
})
it('does not retain a pending image after disposal', async () => {
  const f = fixture()
  let finish!: () => void
  f.decode.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  const pending = f.pool.prepare('/a', f.signal)
  await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(1))
  f.pool.dispose(); finish(); await pending
  expect(f.pool.url('/a')).toBe('/a')
  expect(f.revoke).toHaveBeenCalledWith('blob:prepared-1')
})
it('respects the original stored tile expiry and rejects unversioned responses', async () => {
  const f = fixture()
  f.fetcher.mockImplementation(async () => new Response('png', { headers: { 'content-type': 'image/png' } }))
  await f.pool.prepare('/a', f.signal)
  expect(f.decode).not.toHaveBeenCalled()
  f.fetcher.mockImplementation(async () => new Response('png', { headers: { 'content-type': 'image/png', 'X-Kabanda-Tile-Expires': String(Date.now() + 100) } }))
  const now = Date.now()
  await f.pool.prepare('/b', f.signal)
  vi.spyOn(Date, 'now').mockReturnValue(now + 200)
  expect(f.pool.url('/b')).toBe('/b')
  expect(f.revoke).toHaveBeenCalledWith('blob:prepared-1')
  f.pool.dispose()
})
