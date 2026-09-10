import { describe, expect, it } from 'vitest'
import { relayBytesToBase64 } from '@kabanda/contracts/relay'
import { createApiTransport } from './api-transport'

// Load the real API only inside this test. The PWA dependency graph never imports
// server code, and production typechecking does not acquire Node-only globals.
async function serverModule(name: string) {
  return import(/* @vite-ignore */ new URL(`../../../api/src/${name}.ts`, import.meta.url).href)
}

describe('frontend with the actual encrypted API bridge', () => {
  it('keeps production auth, binary media and logout working across the full protocol', async () => {
    const [{ buildApp }, { loadConfig }, { buildRelayBridge }] = await Promise.all([
      serverModule('app'), serverModule('config'), serverModule('relay-bridge'),
    ])
    const keys = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' }, true, ['wrapKey', 'unwrapKey'])
    const pem = (kind: string, bytes: ArrayBuffer) => `-----BEGIN ${kind} KEY-----\n${relayBytesToBase64(new Uint8Array(bytes))}\n-----END ${kind} KEY-----`
    const privateKey = pem('PRIVATE', await crypto.subtle.exportKey('pkcs8', keys.privateKey))
    const publicKey = pem('PUBLIC', await crypto.subtle.exportKey('spki', keys.publicKey))
    const origin = 'https://kabanda.website.yandexcloud.net'
    const bucket = 'kabanda-test-private'
    const base = `https://storage.yandexcloud.net/${bucket}/transport/v1/blobs/kabanda/`
    const raidId = 'ca3b435d-d2a6-4611-98bb-d8f80a586bb3'
    const mediaId = '83340514-959f-49fb-9d29-ddb37f4bfe50'
    const user = { id: '04363dc4-a6cb-4657-9d20-bf5a9c9456dd', username: 'synthetic', identityKind: 'invite', displayName: 'Test', avatarUrl: null, email: null }
    const rawToken = 'synthetic-session-only-inside-test-api'
    let liveSession = true
    let uploaded: Uint8Array | undefined
    const media = Uint8Array.from({ length: 80_000 }, (_, index) => index % 251)
    const config = loadConfig({ NODE_ENV: 'production', APP_ORIGIN: origin, TRUST_PROXY_ADDRESS: 'loopback',
      ALPHA_ACCESS_MODE: 'enforced', ALPHA_ACCESS_SECRET: 'synthetic-test-alpha-secret-32-characters',
      MEDIA_CAPABILITY_SECRET: 'synthetic-media-secret-32-characters',
    })
    let inviteCreations = 0
    const app = await buildApp({ config, readiness: async () => {},
      auth: {
        requestMagicLink: async () => {}, verifyMagicLink: async () => null,
        loginWithPassword: async () => { liveSession = true; return { rawToken, user, returnTo: '/app' } },
        getUser: async (token: string) => liveSession && token === rawToken ? user : null,
        revokeSession: async () => { liveSession = false }, updateProfile: async () => user,
      },
      kabandas: {
        listKabandas: async () => [],
        createInvite: async () => {
          inviteCreations += 1
          await new Promise(resolve => setTimeout(resolve, 120))
          return { id: 'one-invitation' }
        },
      },
      raids: {
        readMedia: async (identity: string) => { expect(identity).toBe(user.id); return { contentType: 'image/png', bytes: media } },
        uploadMedia: async (identity: string, _raidId: string, _intent: string, capability: string, sha256: string, bytes: Uint8Array) => {
          expect(identity).toBe(user.id)
          expect(capability).toBe('c'.repeat(32))
          expect(sha256).toBe('a'.repeat(64))
          uploaded = bytes
          return { media: { id: mediaId } }
        },
      },
    })
    app.log.level = 'silent'
    const objects = new Map<string, Uint8Array>()
    const tickets = new Map<string, { id: string; owner: string }>()
    const bridge = await buildRelayBridge({ deadlineMs: 50, app, publicOrigin: origin, cookieName: config.cookieName,
      pendingInviteCookieName: '__Host-kabanda_pending_invite', sessionSecret: 'synthetic-bridge-session-secret-at-least-32', privateKeyPkcs8Pem: privateKey,
      blobs: {
        prepareUpload: async ({ id, owner }: { id: string; owner: string }) => {
          const ticket = crypto.randomUUID()
          tickets.set(ticket, { id, owner })
          return { url: `${base}uploads/${ticket}`, ticket }
        },
        readUpload: async ({ ticket, id, owner }: { ticket: string; id: string; owner: string }) => {
          expect(tickets.get(ticket)).toEqual({ id, owner })
          return objects.get(`${base}uploads/${ticket}`)!
        },
        publishResponse: async ({ id, body }: { id: string; body: Uint8Array }) => {
          const url = `${base}responses/${id}`
          objects.set(url, body)
          return url
        },
      },
    })
    const values = new Map<string, string>()
    const transport = createApiTransport({ bootstrapUrl: 'https://storage.yandexcloud.net/kabanda/transport/v1/apps/kabanda/bootstrap.json', publicKey, storageBucket: bucket }, {
      origin, timeoutMs: 2000, storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } },
      relayFetch: async (_input, init) => {
        const result = await bridge.inject({ method: 'POST', url: '/relay/v1/request', headers: { 'content-type': 'application/json' }, payload: init?.body })
        expect(result.body).not.toContain(rawToken)
        return new Response(result.rawPayload, { status: result.statusCode, headers: { 'content-type': 'application/json' } })
      },
      fetchImpl: async (input, init) => {
        const url = String(input)
        expect(url.startsWith(base)).toBe(true)
        if (init?.method === 'PUT') {
          const encrypted = new Uint8Array(await new Response(init.body).arrayBuffer())
          expect(encrypted).not.toEqual(media)
          objects.set(url, encrypted)
          return new Response(null, { status: 200 })
        }
        return new Response(new Uint8Array(objects.get(url)!), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    try {
      const json = { 'Content-Type': 'application/json' }
      const login = await transport.request('/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ username: 'synthetic', password: 'long-password' }) })
      expect(login.status).toBe(200)
      expect((await login.json()).user).toEqual(user)
      expect(JSON.stringify([...values.values()])).not.toContain(rawToken)
      expect((await (await transport.request('/api/me')).json()).user.id).toBe(user.id)
      const photo = await transport.request(`/api/raids/${raidId}/media/${mediaId}/content`)
      expect(photo.status).toBe(200)
      expect(photo.headers.get('content-type')).toContain('image/png')
      expect(new Uint8Array(await photo.arrayBuffer())).toEqual(media)
      const upload = await transport.request(`/api/raids/${raidId}/media/intents/${mediaId}/content`, {
        method: 'PUT', body: new Blob([media], { type: 'image/png' }),
        headers: { 'Content-Type': 'image/png', 'X-Upload-Capability': 'c'.repeat(32), 'X-Content-SHA256': 'a'.repeat(64) },
      })
      expect(upload.status).toBe(200)
      expect(new Uint8Array(uploaded!)).toEqual(media)
      const invite = await transport.request(`/api/kabandas/${raidId}/invites`, { method: 'POST', headers: json, body: '{"expiresInHours":24}' })
      expect(invite.status).toBe(201)
      expect((await invite.json()).invite.id).toBe('one-invitation')
      expect(inviteCreations).toBe(1)
      const logout = await transport.request('/api/auth/logout', { method: 'POST', body: '{}', headers: json })
      expect(logout.status).toBe(204)
      expect(logout.body).toBeNull()
      expect(values.size).toBe(0)
      expect((await transport.request('/api/me')).status).toBe(401)
    } finally {
      transport.dispose()
      await bridge.close()
      await app.close()
    }
  })
})
