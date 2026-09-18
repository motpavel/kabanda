import { beforeEach, expect, it, vi } from 'vitest'

const requestApi = vi.hoisted(() => vi.fn())
vi.mock('./api-transport', () => ({ requestApi }))

beforeEach(() => {
  vi.resetModules()
  requestApi.mockReset()
  vi.stubGlobal('window', new EventTarget())
})

it('publishes a mutation under the relay identity adopted from another tab', async () => {
  const { subscribeConfirmedWrites } = await import('./api-events')
  const { requestJson } = await import('./http')
  const confirmed: Array<{ identityId: string | null | undefined }> = []
  subscribeConfirmedWrites(event => confirmed.push(event))
  window.dispatchEvent(new CustomEvent('kabanda:identity-changed', { detail: { userId: 'old-user' } }))
  window.dispatchEvent(Object.assign(new Event('storage'), {
    key: 'kabanda:relay-session:v1',
    newValue: JSON.stringify({ opaque: 'new-session', identityId: 'new-user' }),
  }))
  requestApi.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }))

  await requestJson('/api/raids/raid/participants/me/ready', { method: 'POST', body: '{}' })

  expect(confirmed).toEqual([{ identityId: 'new-user', path: '/api/raids/raid/participants/me/ready', body: { ok: true } }])
})
