import { alphaDiagnosticSignalSchema, type User } from '@kabanda/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildMagicLinkVerificationUrl,
  type AuthService,
  type VerifiedSession,
} from '../src/auth.js'
import { buildApp, privacySafeOperationRef } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import type { KabandaService } from '../src/kabandas.js'
import { GeocodingError, type GeocodingService } from '../src/geocoding.js'
import {
  deriveMediaUploadCapability,
  escapeShareCardXml,
  renderRaidShareCard,
  resolveExpiringStatus,
  type RaidResult,
  type RaidService,
} from '../src/raids.js'
import {
  RaidTemplateError,
  type RaidTemplateProjection,
  type RaidTemplateService,
} from '../src/raid-templates.js'

const user: User = {
  id: '7484a9f8-11dd-45bd-9740-44b52413fa6b',
  email: 'pavel@example.com',
  username: null,
  identityKind: 'verified',
  displayName: 'Павел',
  avatarUrl: null,
}

const testOrigin = 'http://localhost:5173'

it('projects claim and fallback expiry only from the SQL-derived flag', () => {
  expect(resolveExpiringStatus('pending', 'pending', false)).toBe('pending')
  expect(resolveExpiringStatus('pending', 'pending', true)).toBe('expired')
  expect(resolveExpiringStatus('pending_verifier', 'pending_verifier', false)).toBe(
    'pending_verifier',
  )
  expect(resolveExpiringStatus('pending_verifier', 'pending_verifier', true)).toBe('expired')
  expect(resolveExpiringStatus('expired_finalization', 'pending', false)).toBe('expired')
})

function createAuth(overrides: Partial<AuthService> = {}): AuthService {
  return {
    requestMagicLink: vi.fn().mockResolvedValue(undefined),
    verifyMagicLink: vi.fn().mockResolvedValue(null),
    loginWithPassword: vi.fn().mockResolvedValue(null),
    getUser: vi.fn().mockResolvedValue(null),
    updateProfile: vi.fn().mockResolvedValue(null),
    revokeSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function createKabandas(overrides: Partial<KabandaService> = {}): KabandaService {
  return {
    listKabandas: vi.fn().mockResolvedValue([]),
    createKabanda: vi.fn(),
    updateKabanda: vi.fn(),
    listMembers: vi.fn().mockResolvedValue([]),
    leaveKabanda: vi.fn(),
    removeMember: vi.fn(),
    transferLeadership: vi.fn(),
    createInvite: vi.fn(),
    revokeInvite: vi.fn(),
    previewInvite: vi.fn(),
    previewContinuation: vi.fn(),
    acceptInvite: vi.fn(),
    acceptInviteWithCredentials: vi.fn(),
    listPoints: vi.fn().mockResolvedValue({ points: [], nextCursor: null }),
    ...overrides,
  }
}

function createRaids(overrides: Partial<RaidService> = {}): RaidService {
  return {
    createDraft: vi.fn(),
    command: vi.fn(),
    reportReadiness: vi.fn(),
    acquireNavigatorLease: vi.fn(),
    recoverNavigatorLease: vi.fn(),
    submitRouteBatch: vi.fn(),
    getRouteTrack: vi.fn().mockResolvedValue({ segments: [], pointCount: 0, truncated: false, updatedAt: null, serverAt: '2026-08-28T12:00:00.000Z' }),
    getRaid: vi.fn(),
    getCurrent: vi.fn().mockResolvedValue(null),
    listActionable: vi.fn().mockResolvedValue([]),
    nearbyCheckins: vi.fn().mockResolvedValue({ policy: {}, points: [] }),
    createCheckin: vi.fn(),
    listPendingClaims: vi.fn().mockResolvedValue({ claims: [] }),
    respondClaim: vi.fn(),
    createFallback: vi.fn(),
    listPendingFallbacks: vi.fn().mockResolvedValue({ fallbacks: [] }),
    respondFallback: vi.fn(),
    createMediaIntent: vi.fn(),
    uploadMedia: vi.fn(),
    listMedia: vi.fn().mockResolvedValue({ media: [], nextCursor: null }),
    readMedia: vi.fn(),
    tombstoneMedia: vi.fn(),
    finishRaid: vi.fn(),
    settleFinalization: vi.fn(),
    leaveRaid: vi.fn(),
    getResult: vi.fn(),
    listHistory: vi.fn().mockResolvedValue({ raids: [], nextCursor: null }),
    getProgress: vi.fn(),
    getShareCard: vi.fn(),
    ...overrides,
  }
}

function createRaidTemplates(overrides: Partial<RaidTemplateService> = {}): RaidTemplateService {
  return {
    createTemplate: vi.fn(),
    listTemplates: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn(),
    readCover: vi.fn(),
    ...overrides,
  }
}

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function createTestApp(
  auth: AuthService,
  kabandas = createKabandas(),
  raids?: RaidService,
  options: {
    environment?: Record<string, string>
    onDiagnosticSignal?: (signal: Parameters<NonNullable<import('../src/app.js').AppDependencies['onDiagnosticSignal']>>[0]) => void
    raidTemplates?: RaidTemplateService
    geocoding?: GeocodingService
  } = {},
) {
  const app = await buildApp({
    auth,
    kabandas,
    ...(raids ? { raids } : {}),
    ...(options.raidTemplates ? { raidTemplates: options.raidTemplates } : {}),
    ...(options.geocoding ? { geocoding: options.geocoding } : {}),
    config: loadConfig({ NODE_ENV: 'test', ...options.environment }),
    readiness: vi.fn().mockResolvedValue(undefined),
    ...(options.onDiagnosticSignal ? { onDiagnosticSignal: options.onDiagnosticSignal } : {}),
  })
  apps.push(app)
  return app
}

describe('API foundation', () => {
  it('accepts only the five bounded privacy-safe diagnostic signals', () => {
    const common = {
      schemaVersion: 1 as const,
      signalId: 'f43b057b-4f76-4b85-a898-938e87271b51',
      diagnosticSessionId: 'c97eff29-882f-4c52-a18f-d27bbbf3b896',
      occurredAt: '2026-08-28T12:00:00.000Z',
      clientBuild: 'eee8a18',
      swBuild: 'eee8a18',
      displayMode: 'standalone' as const,
    }
    expect(alphaDiagnosticSignalSchema.parse({ ...common, kind: 'gps_stale', ageBucket: '15_30s' }).kind).toBe('gps_stale')
    expect(alphaDiagnosticSignalSchema.parse({ ...common, kind: 'gps_stopped', reason: 'timeout' }).kind).toBe('gps_stopped')
    expect(alphaDiagnosticSignalSchema.parse({
      ...common,
      kind: 'queue_stalled',
      queue: 'route',
      countBucket: '2_5',
      oldestAgeBucket: '2_5m',
      attemptBucket: '3_5',
      errorClass: 'network',
    }).kind).toBe('queue_stalled')
    expect(alphaDiagnosticSignalSchema.parse({
      ...common,
      kind: 'media_failed',
      stage: 'upload',
      terminal: false,
      attemptBucket: '3_5',
      errorClass: 'server',
    }).kind).toBe('media_failed')
    expect(alphaDiagnosticSignalSchema.parse({
      ...common,
      kind: 'sw_mismatch',
      state: 'waiting_deferred',
      durableWorkBucket: '1_5',
      recorderActive: true,
      activeSwBuild: 'old',
      waitingSwBuild: 'new',
    }).kind).toBe('sw_mismatch')
    expect(() => alphaDiagnosticSignalSchema.parse({
      ...common,
      kind: 'gps_stale',
      ageBucket: '15_30s',
      latitude: 56.85,
      token: 'private',
      message: 'free text',
    })).toThrow()
  })

  it('hashes operation references without exposing the idempotency key', () => {
    const raw = 'customer-entered-operation-key'
    const reference = privacySafeOperationRef(raw)
    expect(reference).toMatch(/^[a-f0-9]{16}$/)
    expect(reference).not.toContain(raw)
    expect(privacySafeOperationRef(raw)).toBe(reference)
  })

  it('derives stable upload capabilities from a dedicated secret and intent identity', () => {
    const args = [
      'test-media-capability-secret-at-least-32-bytes',
      'b890c06f-4d24-43a4-8ae3-ebf7258bf803',
      '939d919d-6c8a-47f1-9a1d-feef78f8df46',
      user.id,
    ] as const
    const capability = deriveMediaUploadCapability(...args)

    expect(deriveMediaUploadCapability(...args)).toBe(capability)
    expect(
      deriveMediaUploadCapability(
        args[0],
        args[1],
        '9c1d603f-c79d-46f4-806c-f57f040e2d91',
        args[3],
      ),
    ).not.toBe(capability)
    expect(capability).toHaveLength(43)
    expect(capability).not.toContain(args[0])
  })

  it('requires a dedicated media capability secret in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      'MEDIA_CAPABILITY_SECRET must be configured in production',
    )
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        MEDIA_CAPABILITY_SECRET: 'production-media-capability-secret-at-least-32-bytes',
        ALPHA_ACCESS_MODE: 'enforced',
        ALPHA_ACCESS_SECRET: 'production-alpha-access-secret-at-least-32-bytes',
      }),
    ).not.toThrow()
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        MEDIA_CAPABILITY_SECRET: 'production-media-capability-secret-at-least-32-bytes',
      }),
    ).toThrow('ALPHA_ACCESS_MODE must be enforced in production')
  })

  it('requires HTTPS for a non-loopback production origin and paired SMTP credentials', () => {
    const productionSecret = 'production-media-capability-secret-at-least-32-bytes'
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        MEDIA_CAPABILITY_SECRET: productionSecret,
        ALPHA_ACCESS_MODE: 'enforced',
        ALPHA_ACCESS_SECRET: 'production-alpha-access-secret-at-least-32-bytes',
        APP_ORIGIN: 'http://preview.example.com',
      }),
    ).toThrow('APP_ORIGIN must use HTTPS outside loopback in production')
    expect(() => loadConfig({ SMTP_USER: 'preview-user' })).toThrow(
      'SMTP_USER and SMTP_PASSWORD must be configured together',
    )
    expect(() =>
      loadConfig({ SMTP_USER: 'preview-user', SMTP_PASSWORD: 'preview-password' }),
    ).toThrow('Authenticated SMTP requires implicit TLS or required STARTTLS')
    expect(
      loadConfig({
        SMTP_USER: 'preview-user',
        SMTP_PASSWORD: 'preview-password',
        SMTP_REQUIRE_TLS: 'true',
      }).SMTP_USER,
    ).toBe('preview-user')
  })

  it('serves the production PWA with bounded caching and keeps API 404s as JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kabanda-static-'))
    temporaryDirectories.push(directory)
    await mkdir(join(directory, 'assets'))
    await mkdir(join(directory, 'api'))
    await writeFile(join(directory, 'index.html'), '<!doctype html><title>Kabanda preview</title>')
    await writeFile(join(directory, 'manifest.webmanifest'), '{"name":"Kabanda"}')
    await writeFile(join(directory, 'sw.js'), 'self.addEventListener("fetch",()=>{})')
    await writeFile(join(directory, 'assets', 'app-abc123.js'), 'globalThis.kabanda=true')
    await writeFile(join(directory, 'api', 'me'), 'must-not-bypass-api-auth')

    const app = await createTestApp(createAuth(), createKabandas(), undefined, {
      environment: { PWA_DIST_DIR: directory, API_BUILD_ID: 'preview-build' },
    })
    const spa = await app.inject({
      method: 'GET',
      url: '/app',
      headers: { accept: 'text/html,application/xhtml+xml' },
    })
    expect(spa.statusCode).toBe(200)
    expect(spa.body).toContain('Kabanda preview')
    expect(spa.headers['cache-control']).toBe('no-store')
    expect(spa.headers['permissions-policy']).toContain('geolocation=(self)')
    expect(spa.headers['x-kabanda-app-build']).toBe('preview-build')

    const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' })
    expect(asset.statusCode).toBe(200)
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable')

    const missingAsset = await app.inject({
      method: 'GET',
      url: '/assets/missing.js',
      headers: { accept: '*/*' },
    })
    expect(missingAsset.statusCode).toBe(404)
    expect(missingAsset.headers['content-type']).toContain('application/json')

    for (const path of ['/assets/../api/me', '/assets/%2E%2E/api/me']) {
      const traversal = await app.inject({ method: 'GET', url: path, headers: { accept: '*/*' } })
      expect(traversal.statusCode).toBe(401)
      expect(traversal.body).not.toContain('must-not-bypass-api-auth')
    }

    const manifest = await app.inject({ method: 'GET', url: '/manifest.webmanifest' })
    expect(manifest.headers['cache-control']).toBe('no-store')

    const missingApi = await app.inject({ method: 'GET', url: '/api/not-real' })
    expect(missingApi.statusCode).toBe(404)
    expect(missingApi.json()).toEqual({
      error: expect.objectContaining({ code: 'NOT_FOUND' }),
    })
    expect(missingApi.headers['content-type']).toContain('application/json')

    const exactApi = await app.inject({
      method: 'GET',
      url: '/api?from=navigation',
      headers: { accept: 'text/html' },
    })
    expect(exactApi.statusCode).toBe(404)
    expect(exactApi.headers['content-type']).toContain('application/json')
  })

  it('fails closed on the wrong production host, protocol, or mutation origin', async () => {
    const origin = 'https://preview.trycloudflare.com'
    const app = await createTestApp(createAuth(), createKabandas(), undefined, {
      environment: {
        NODE_ENV: 'production',
        APP_ORIGIN: origin,
        TRUST_PROXY_ADDRESS: '127.0.0.1',
        MEDIA_CAPABILITY_SECRET: 'production-media-capability-secret-at-least-32-bytes',
        ALPHA_ACCESS_MODE: 'enforced',
        ALPHA_ACCESS_SECRET: 'production-alpha-access-secret-at-least-32-bytes',
      },
    })
    const canonicalHeaders = {
      host: 'preview.trycloudflare.com',
      'x-forwarded-proto': 'https',
      origin,
    }
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: canonicalHeaders,
      remoteAddress: '127.0.0.1',
    })
    expect(accepted.statusCode).toBe(204)

    const foreignOrigin = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...canonicalHeaders, origin: 'https://foreign.example' },
      remoteAddress: '127.0.0.1',
    })
    expect(foreignOrigin.statusCode).toBe(403)

    const wrongHost = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:3000', 'x-forwarded-proto': 'https' },
      remoteAddress: '127.0.0.1',
    })
    expect(wrongHost.statusCode).toBe(421)

    const insecure = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'preview.trycloudflare.com' },
      remoteAddress: '127.0.0.1',
    })
    expect(insecure.statusCode).toBe(400)
  })

  it('renders one deterministic metadata-free private PNG result card', async () => {
    const result: RaidResult = {
      schemaVersion: 1,
      raid: {
        id: '81297402-898c-48d6-bc78-c74b6b38205c',
        kabandaId: '2e56a447-23dc-4507-af50-5b8c2430ac81',
        title: 'Рейд <script>& "кабан"',
        startedAt: '2026-08-28T10:00:00.000Z',
        completedAt: '2026-08-28T11:00:00.000Z',
        partial: false,
      },
      team: { durationSeconds: 3600, distanceMeters: 12_345.6, uniquePoints: 7, photos: 3 },
      personal: { durationSeconds: 1800, distanceMeters: 6000, uniquePoints: 4, photos: 1 },
      participants: [
        {
          userId: user.id,
          displayName: 'Павел',
          metrics: { durationSeconds: 1800, distanceMeters: 6000, uniquePoints: 4, photos: 1 },
        },
      ],
    }
    expect(escapeShareCardXml(result.raid.title)).toBe(
      'Рейд &lt;script&gt;&amp; &quot;кабан&quot;',
    )
    const first = await renderRaidShareCard(result)
    const second = await renderRaidShareCard(result)
    expect(first.equals(second)).toBe(true)
    expect(first.length).toBeLessThan(1024 * 1024)
    expect(first.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    const chunkTypes: string[] = []
    for (let offset = 8; offset + 12 <= first.length; ) {
      const length = first.readUInt32BE(offset)
      chunkTypes.push(first.subarray(offset + 4, offset + 8).toString('ascii'))
      offset += length + 12
    }
    expect(chunkTypes).not.toEqual(
      expect.arrayContaining(['eXIf', 'iTXt', 'tEXt', 'zTXt', 'iCCP']),
    )
  })

  it('reports liveness', async () => {
    const app = await createTestApp(createAuth())
    const response = await app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok', service: 'kabanda-api' })
    expect(response.headers['x-kabanda-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(response.headers['x-kabanda-api-build']).toBe('dev')
  })

  it('adds error and hashed operation identifiers without echoing the raw key', async () => {
    const app = await createTestApp(createAuth())
    const rawKey = 'private-looking-operation-key'
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin: 'https://wrong.example', 'idempotency-key': rawKey },
    })
    const body = response.json()
    expect(response.statusCode).toBe(403)
    expect(body.error.errorId).toBe(response.headers['x-kabanda-request-id'])
    expect(body.error.operationRef).toBe(privacySafeOperationRef(rawKey))
    expect(response.headers['x-kabanda-operation-ref']).toBe(privacySafeOperationRef(rawKey))
    expect(JSON.stringify(body)).not.toContain(rawKey)
  })

  it('accepts a bounded diagnostic signal only for an authenticated same-origin session', async () => {
    const onDiagnosticSignal = vi.fn()
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas(),
      undefined,
      { environment: { ALPHA_DIAGNOSTICS_ENABLED: 'true' }, onDiagnosticSignal },
    )
    const signal = {
      schemaVersion: 1,
      signalId: 'f43b057b-4f76-4b85-a898-938e87271b51',
      diagnosticSessionId: 'c97eff29-882f-4c52-a18f-d27bbbf3b896',
      occurredAt: '2026-08-28T12:00:00.000Z',
      clientBuild: 'eee8a18',
      swBuild: null,
      displayMode: 'browser',
      kind: 'gps_stopped',
      reason: 'storage_error',
    }
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/diagnostics/signals',
      headers: {
        origin: testOrigin,
        cookie: 'kabanda_session=session',
        'x-kabanda-diagnostic-session': signal.diagnosticSessionId,
        'x-kabanda-client-build': signal.clientBuild,
      },
      payload: signal,
    })
    expect(accepted.statusCode).toBe(202)
    expect(accepted.json()).toEqual({ accepted: true })
    expect(onDiagnosticSignal).toHaveBeenCalledTimes(1)

    const anonymous = await createTestApp(
      createAuth(),
      createKabandas(),
      undefined,
      { environment: { ALPHA_DIAGNOSTICS_ENABLED: 'true' } },
    )
    const denied = await anonymous.inject({
      method: 'POST',
      url: '/api/diagnostics/signals',
      headers: {
        origin: testOrigin,
        'x-kabanda-diagnostic-session': signal.diagnosticSessionId,
        'x-kabanda-client-build': signal.clientBuild,
      },
      payload: signal,
    })
    expect(denied.statusCode).toBe(401)

    const sensitive = await app.inject({
      method: 'POST',
      url: '/api/diagnostics/signals',
      headers: {
        origin: testOrigin,
        cookie: 'kabanda_session=session',
        'x-kabanda-diagnostic-session': signal.diagnosticSessionId,
        'x-kabanda-client-build': signal.clientBuild,
      },
      payload: { ...signal, longitude: 53.2 },
    })
    expect(sensitive.statusCode).toBe(400)
    expect(onDiagnosticSignal).toHaveBeenCalledTimes(1)

    const oversized = await app.inject({
      method: 'POST',
      url: '/api/diagnostics/signals',
      headers: {
        origin: testOrigin,
        cookie: 'kabanda_session=session',
        'x-kabanda-diagnostic-session': signal.diagnosticSessionId,
        'x-kabanda-client-build': signal.clientBuild,
      },
      payload: { ...signal, forbiddenPadding: 'x'.repeat(5_000) },
    })
    expect(oversized.statusCode).toBe(413)
    expect(onDiagnosticSignal).toHaveBeenCalledTimes(1)
  })

  it('keeps the diagnostics endpoint disabled by default', async () => {
    const app = await createTestApp(createAuth({ getUser: vi.fn().mockResolvedValue(user) }))
    const response = await app.inject({
      method: 'POST',
      url: '/api/diagnostics/signals',
      headers: { origin: testOrigin, cookie: 'kabanda_session=session' },
      payload: {},
    })
    expect(response.statusCode).toBe(404)
  })

  it('accepts a valid magic-link request without exposing a token', async () => {
    const auth = createAuth()
    const app = await createTestApp(auth)
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/request-link',
      headers: { origin: testOrigin },
      payload: { email: 'pavel@example.com', returnTo: '/lobby/raid-1' },
    })
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ accepted: true })
    expect(auth.requestMagicLink).toHaveBeenCalledWith('pavel@example.com', '/lobby/raid-1')
  })

  it('keeps the raw magic token in a fragment that is not sent to the server', () => {
    const rawToken = 'x'.repeat(32)
    const url = new URL(buildMagicLinkVerificationUrl(testOrigin, rawToken, '/kabanda/'))
    expect(url.pathname).toBe('/kabanda/auth/verify')
    expect(url.search).toBe('')
    expect(new URLSearchParams(url.hash.slice(1)).get('token')).toBe(rawToken)
  })

  it('does not consume a magic link through GET or mail prefetch', async () => {
    const auth = createAuth()
    const app = await createTestApp(auth)
    const response = await app.inject({
      method: 'GET',
      url: `/api/auth/verify?token=${'x'.repeat(32)}`,
    })
    expect(response.statusCode).toBe(404)
    expect(auth.verifyMagicLink).not.toHaveBeenCalled()
  })

  it('sets an HttpOnly cookie after an explicit same-origin exchange', async () => {
    const verified: VerifiedSession = { rawToken: 'raw-session-token', returnTo: '/home', user }
    const app = await createTestApp(
      createAuth({ verifyMagicLink: vi.fn().mockResolvedValue(verified) }),
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: { origin: testOrigin },
      payload: { token: 'x'.repeat(32) },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['set-cookie']).toContain('HttpOnly')
    expect(response.json()).toEqual({ returnTo: '/home' })
  })

  it('sets an HttpOnly cookie after a rate-limited password login', async () => {
    const loginWithPassword = vi.fn().mockResolvedValue({
      rawToken: 'password-session-token',
      returnTo: '/',
      user: { ...user, email: null, username: 'pavel', identityKind: 'invite' },
    })
    const app = await createTestApp(createAuth({ loginWithPassword }))
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: testOrigin },
      payload: { username: 'pavel', password: 'long-password' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['set-cookie']).toContain('HttpOnly')
    expect(loginWithPassword).toHaveBeenCalledWith('pavel', 'long-password')
  })

  it('allows only one winner for two concurrent exchanges', async () => {
    const verified: VerifiedSession = { rawToken: 'raw-session-token', returnTo: '/home', user }
    const verifyMagicLink = vi.fn().mockResolvedValueOnce(verified).mockResolvedValueOnce(null)
    const app = await createTestApp(createAuth({ verifyMagicLink }))
    const request = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/verify',
        headers: { origin: testOrigin },
        payload: { token: 'x'.repeat(32) },
      })

    const responses = await Promise.all([request(), request()])
    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 400])
    expect(verifyMagicLink).toHaveBeenCalledTimes(2)
  })

  it('rejects unsafe API requests without the configured origin', async () => {
    const auth = createAuth()
    const app = await createTestApp(auth)
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('ORIGIN_NOT_ALLOWED')
    expect(auth.revokeSession).not.toHaveBeenCalled()
  })

  it('does not expose the profile without a valid session', async () => {
    const app = await createTestApp(createAuth())
    const response = await app.inject({ method: 'GET', url: '/api/me' })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('AUTH_REQUIRED')
  })

  it('creates a Kabanda with a client idempotency key', async () => {
    const createKabanda = vi.fn().mockResolvedValue({
      id: '81297402-898c-48d6-bc78-c74b6b38205c',
      name: 'Ночные кабаны',
      avatar: '🌙',
      role: 'owner',
      memberCount: 1,
      pointsCollectionId: null,
    })
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas({ createKabanda }),
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/kabandas',
      headers: { origin: testOrigin, cookie: 'kabanda_session=session', 'idempotency-key': 'create-1234' },
      payload: { name: 'Ночные кабаны', avatar: '🌙' },
    })
    expect(response.statusCode).toBe(201)
    expect(createKabanda).toHaveBeenCalledWith(user.id, 'Ночные кабаны', '🌙', 'create-1234')
  })

  it('does not let an invite identity create another Kabanda', async () => {
    const inviteUser: User = {
      ...user,
      email: null,
      username: 'invite-user',
      identityKind: 'invite',
    }
    const createKabanda = vi.fn()
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(inviteUser) }),
      createKabandas({ createKabanda }),
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/kabandas',
      headers: { origin: testOrigin, cookie: 'kabanda_session=session', 'idempotency-key': 'create-1234' },
      payload: { name: 'Чужая Кабанда', avatar: '🐗' },
    })
    expect(response.statusCode).toBe(403)
    expect(createKabanda).not.toHaveBeenCalled()
  })

  it('updates Kabanda presentation through the owner-checked service', async () => {
    const coverImage = `data:image/jpeg;base64,${'A'.repeat(32)}`
    const updateKabanda = vi.fn().mockResolvedValue({
      id: '81297402-898c-48d6-bc78-c74b6b38205c',
      name: 'Новый маршрут',
      avatar: '🐗',
      coverImage,
      role: 'owner',
      memberCount: 1,
      pointsCollectionId: null,
    })
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas({ updateKabanda }),
    )
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/kabandas/81297402-898c-48d6-bc78-c74b6b38205c',
      headers: { origin: testOrigin, cookie: 'kabanda_session=session' },
      payload: { name: 'Новый маршрут', coverImage },
    })
    expect(response.statusCode).toBe(200)
    expect(updateKabanda).toHaveBeenCalledWith(
      user.id,
      '81297402-898c-48d6-bc78-c74b6b38205c',
      { name: 'Новый маршрут', coverImage },
    )
  })

  it('rejects an unsafe Kabanda cover before calling the service', async () => {
    const updateKabanda = vi.fn()
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas({ updateKabanda }),
    )
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/kabandas/81297402-898c-48d6-bc78-c74b6b38205c',
      headers: { origin: testOrigin, cookie: 'kabanda_session=session' },
      payload: { coverImage: 'https://example.com/tracker.jpg' },
    })
    expect(response.statusCode).toBe(400)
    expect(updateKabanda).not.toHaveBeenCalled()
  })

  it('passes leadership only through the authenticated Kabanda service', async () => {
    const memberId = '383bb699-4f6b-423a-876d-bb143cfa97f3'
    const transferLeadership = vi.fn().mockResolvedValue({
      id: '81297402-898c-48d6-bc78-c74b6b38205c',
      name: 'Ночные кабаны',
      avatar: '🐗',
      coverImage: null,
      role: 'member',
      memberCount: 2,
      pointsCollectionId: null,
    })
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas({ transferLeadership }),
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/kabandas/81297402-898c-48d6-bc78-c74b6b38205c/leadership',
      headers: { origin: testOrigin, cookie: 'kabanda_session=session' },
      payload: { memberId },
    })
    expect(response.statusCode).toBe(200)
    expect(transferLeadership).toHaveBeenCalledWith(
      user.id,
      '81297402-898c-48d6-bc78-c74b6b38205c',
      memberId,
    )
  })

  it('never places a raw invite token in a redirect', async () => {
    const previewInvite = vi.fn().mockResolvedValue({
      continuation: 'continuation-secret',
      kabanda: {
        id: '81297402-898c-48d6-bc78-c74b6b38205c',
        name: 'Ночные кабаны',
        avatar: '🌙',
        role: 'member',
        memberCount: 1,
        pointsCollectionId: null,
      },
      inviterName: 'Павел',
      expiresAt: new Date().toISOString(),
      requiresAuth: true,
      accepted: false,
    })
    const app = await createTestApp(createAuth(), createKabandas({ previewInvite }))
    const response = await app.inject({
      method: 'POST',
      url: '/api/invites/preview',
      headers: { origin: testOrigin },
      payload: { token: 'x'.repeat(32) },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers.location).toBeUndefined()
    expect(response.json().invite.continuation).toBe('continuation-secret')
    expect(response.headers['set-cookie']).toContain('kabanda_pending_invite=continuation-secret')
    expect(response.headers['set-cookie']).toContain('HttpOnly')
    expect(response.headers['set-cookie']).toContain('SameSite=Lax')
  })

  it('previews the same continuation after auth without issuing another one', async () => {
    const invite = {
      continuation: 'c'.repeat(32),
      kabanda: {
        id: '81297402-898c-48d6-bc78-c74b6b38205c',
        name: 'Ночные кабаны',
        avatar: '🌙',
        role: 'member' as const,
        memberCount: 1,
        pointsCollectionId: null,
      },
      inviterName: 'Павел',
      expiresAt: new Date().toISOString(),
      requiresAuth: false,
      accepted: false,
    }
    const previewContinuation = vi.fn().mockResolvedValue(invite)
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas({ previewContinuation }),
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/invites/preview',
      headers: { origin: testOrigin, cookie: 'kabanda_session=session' },
      payload: { continuation: invite.continuation },
    })
    expect(response.statusCode).toBe(200)
    expect(previewContinuation).toHaveBeenCalledWith(invite.continuation, false, user.id)
    expect(response.json().invite.continuation).toBe(invite.continuation)
  })

  it('recovers a pending invite from an HttpOnly cookie without a URL credential', async () => {
    const invite = {
      continuation: 'c'.repeat(32),
      kabanda: {
        id: '81297402-898c-48d6-bc78-c74b6b38205c',
        name: 'Ночные кабаны',
        avatar: '🌙',
        role: 'member' as const,
        memberCount: 1,
        pointsCollectionId: null,
      },
      inviterName: 'Павел',
      expiresAt: new Date().toISOString(),
      requiresAuth: false,
      accepted: false,
    }
    const previewContinuation = vi.fn().mockResolvedValue(invite)
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas({ previewContinuation }),
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/invites/preview',
      headers: {
        origin: testOrigin,
        cookie: `kabanda_session=session; kabanda_pending_invite=${invite.continuation}`,
      },
      payload: { pending: true },
    })
    expect(response.statusCode).toBe(200)
    expect(previewContinuation).toHaveBeenCalledWith(invite.continuation, false, user.id)
    expect(response.json().invite.kabanda.name).toBe('Ночные кабаны')
  })

  it('registers an anonymous invite member and sets the session cookie atomically', async () => {
    const acceptInviteWithCredentials = vi.fn().mockResolvedValue({
      kabanda: {
        id: '81297402-898c-48d6-bc78-c74b6b38205c',
        name: 'Ночные кабаны',
        avatar: '🌙',
        role: 'member',
        memberCount: 2,
        pointsCollectionId: null,
      },
      rawSessionToken: 'invite-session-token',
    })
    const app = await createTestApp(
      createAuth(),
      createKabandas({ acceptInviteWithCredentials }),
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { origin: testOrigin, 'idempotency-key': 'invite-register-1' },
      payload: { continuation: 'c'.repeat(32), username: 'new-kaban', password: 'long-password' },
    })
    expect(response.statusCode).toBe(200)
    expect(String(response.headers['set-cookie'])).toContain('kabanda_session=invite-session-token')
    expect(String(response.headers['set-cookie'])).toContain('HttpOnly')
    expect(acceptInviteWithCredentials).toHaveBeenCalledWith(
      'c'.repeat(32),
      'invite-register-1',
      expect.objectContaining({ username: 'new-kaban', passwordHash: expect.stringMatching(/^scrypt\$v1\$/) }),
    )
  })

  it('passes expectedVersion and Idempotency-Key to a named raid command', async () => {
    const command = vi.fn().mockResolvedValue({
      receipt: {
        operationId: 'start-operation',
        command: 'start',
        resultingVersion: 5,
        serverAt: new Date().toISOString(),
      },
      raid: { id: '81297402-898c-48d6-bc78-c74b6b38205c', state: 'active', version: 5 },
    })
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas(),
      createRaids({ command }),
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/raids/81297402-898c-48d6-bc78-c74b6b38205c/commands/start',
      headers: {
        origin: testOrigin,
        cookie: 'kabanda_session=session',
        'idempotency-key': 'start-operation',
      },
      payload: { expectedVersion: 4 },
    })
    expect(response.statusCode).toBe(200)
    expect(command).toHaveBeenCalledWith(
      user.id,
      '81297402-898c-48d6-bc78-c74b6b38205c',
      'start',
      { expectedVersion: 4 },
      'start-operation',
    )
  })

  it('delegates raid creation for any authenticated participant to membership authorization', async () => {
    const member = { ...user, id: '383bb699-4f6b-423a-876d-bb143cfa97f3' }
    const createDraft = vi.fn().mockResolvedValue({
      receipt: {
        operationId: 'member-create-raid',
        command: 'create-raid',
        resultingVersion: 1,
        serverAt: '2026-08-28T12:00:00.000Z',
      },
      raid: {
        id: '81297402-898c-48d6-bc78-c74b6b38205c',
        organizerUserId: member.id,
        state: 'draft',
        version: 1,
      },
    })
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(member) }),
      createKabandas(),
      createRaids({ createDraft }),
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/kabandas/2e56a447-23dc-4507-af50-5b8c2430ac81/raids',
      headers: {
        origin: testOrigin,
        cookie: 'kabanda_session=session',
        'idempotency-key': 'member-create-raid',
      },
      payload: { title: 'Рейд участника', description: 'Вечерний круг' },
    })
    expect(response.statusCode).toBe(201)
    expect(createDraft).toHaveBeenCalledWith(
      member.id,
      '2e56a447-23dc-4507-af50-5b8c2430ac81',
      { title: 'Рейд участника', description: 'Вечерний круг' },
      'member-create-raid',
    )
  })

  it('reports device readiness separately from participant readiness', async () => {
    const command = vi.fn().mockResolvedValue({
      receipt: {
        operationId: 'participant-ready-operation',
        command: 'ready',
        resultingVersion: 4,
        serverAt: '2026-08-28T12:00:00.000Z',
      },
      raid: { id: '81297402-898c-48d6-bc78-c74b6b38205c', state: 'lobby', version: 4 },
    })
    const reportReadiness = vi.fn().mockResolvedValue({
      report: {
        status: 'fail',
        blockers: ['LOCATION_PERMISSION', 'LOCATION_STALE', 'LOCATION_INACCURATE'],
        expiresAt: '2026-08-28T12:02:00.000Z',
        raidVersion: 4,
      },
      raid: { id: '81297402-898c-48d6-bc78-c74b6b38205c', state: 'lobby', version: 4 },
    })
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas(),
      createRaids({ command, reportReadiness }),
    )
    const participantResponse = await app.inject({
      method: 'POST',
      url: '/api/raids/81297402-898c-48d6-bc78-c74b6b38205c/participants/me/ready',
      headers: {
        origin: testOrigin,
        cookie: 'kabanda_session=session',
        'idempotency-key': 'participant-ready-operation',
      },
      payload: { expectedVersion: 3 },
    })
    expect(participantResponse.statusCode).toBe(200)
    expect(command).toHaveBeenCalledWith(
      user.id,
      '81297402-898c-48d6-bc78-c74b6b38205c',
      'ready',
      { expectedVersion: 3 },
      'participant-ready-operation',
    )
    const payload = {
      expectedVersion: 4,
      appMode: 'standalone',
      locationPermission: 'unknown',
      coordinateMeasuredAt: null,
      accuracyM: null,
      indexedDbWritable: true,
      storageAvailable: null,
      online: true,
      measuredAt: '2026-08-28T12:00:00.000Z',
    }
    const response = await app.inject({
      method: 'POST',
      url: '/api/raids/81297402-898c-48d6-bc78-c74b6b38205c/readiness',
      headers: {
        origin: testOrigin,
        cookie: 'kabanda_session=session',
        'idempotency-key': 'readiness-operation',
      },
      payload,
    })
    expect(response.statusCode).toBe(200)
    expect(reportReadiness).toHaveBeenCalledWith(
      user.id,
      '81297402-898c-48d6-bc78-c74b6b38205c',
      payload,
      'readiness-operation',
    )
  })

  it('passes a bounded route batch without echoing private coordinates', async () => {
    const submitRouteBatch = vi.fn().mockResolvedValue({
      batchId: '6ca90319-e4ea-43a3-acd9-48055411bd80',
      accepted: [{ operationId: 'sample-operation-one', acceptedAt: '2026-08-28T12:00:01.000Z' }],
      duplicates: [],
      rejected: [],
      routeStatus: {
        status: 'fresh',
        navigatorUserId: user.id,
        generation: 1,
        lastSampleAt: '2026-08-28T12:00:00.000Z',
        lastReceivedAt: '2026-08-28T12:00:01.000Z',
        acceptedSampleCount: 1,
        missingSequenceCount: 0,
      },
      serverAt: '2026-08-28T12:00:01.000Z',
    })
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas(),
      createRaids({ submitRouteBatch }),
    )
    const payload = {
      schemaVersion: 1,
      leaseId: '9ad92175-8a47-4131-86ad-10ed765f8168',
      clientInstanceId: '7bc3d6a1-181e-4d14-a62e-16324b6a9a4f',
      samples: [
        {
          operationId: 'sample-operation-one',
          sequence: 1,
          capturedAt: '2026-08-28T12:00:00.000Z',
          latitude: 56.85,
          longitude: 53.2,
          accuracyM: 8,
        },
      ],
    } as const
    const response = await app.inject({
      method: 'POST',
      url: '/api/raids/81297402-898c-48d6-bc78-c74b6b38205c/route/batches',
      headers: {
        origin: testOrigin,
        cookie: 'kabanda_session=session',
        'idempotency-key': 'route-batch-operation',
      },
      payload,
    })
    expect(response.statusCode).toBe(200)
    expect(submitRouteBatch).toHaveBeenCalledWith(
      user.id,
      '81297402-898c-48d6-bc78-c74b6b38205c',
      payload,
      'route-batch-operation',
    )
    expect(JSON.stringify(response.json())).not.toContain('56.85')
    expect(JSON.stringify(response.json())).not.toContain('53.2')
  })

  it('returns the private no-store route track to an authenticated viewer', async () => {
    const track = {
      segments: [[
        { latitude: 56.85, longitude: 53.2, capturedAt: '2026-08-28T12:00:00.000Z' },
        { latitude: 56.851, longitude: 53.201, capturedAt: '2026-08-28T12:00:05.000Z' },
      ]],
      pointCount: 2,
      truncated: false,
      updatedAt: '2026-08-28T12:00:05.000Z',
      serverAt: '2026-08-28T12:00:06.000Z',
    }
    const getRouteTrack = vi.fn().mockResolvedValue(track)
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas(),
      createRaids({ getRouteTrack }),
    )
    const response = await app.inject({
      method: 'GET',
      url: '/api/raids/81297402-898c-48d6-bc78-c74b6b38205c/route/track',
      headers: { cookie: 'kabanda_session=session' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.json()).toEqual({ track })
    expect(getRouteTrack).toHaveBeenCalledWith(user.id, '81297402-898c-48d6-bc78-c74b6b38205c')
  })

  it('registers the canonical route lease acquire endpoint', async () => {
    const acquireNavigatorLease = vi.fn().mockResolvedValue({
      receipt: {
        operationId: 'route-acquire-operation',
        command: 'acquire-route',
        serverAt: '2026-08-28T12:00:00.000Z',
      },
      raid: { id: '81297402-898c-48d6-bc78-c74b6b38205c' },
    })
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas(),
      createRaids({ acquireNavigatorLease }),
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/raids/81297402-898c-48d6-bc78-c74b6b38205c/route/lease/acquire',
      headers: {
        origin: testOrigin,
        cookie: 'kabanda_session=session',
        'idempotency-key': 'route-acquire-operation',
      },
      payload: {
        expectedVersion: 5,
        clientInstanceId: '7bc3d6a1-181e-4d14-a62e-16324b6a9a4f',
      },
    })
    expect(response.statusCode).toBe(200)
    expect(acquireNavigatorLease).toHaveBeenCalledWith(
      user.id,
      '81297402-898c-48d6-bc78-c74b6b38205c',
      {
        expectedVersion: 5,
        clientInstanceId: '7bc3d6a1-181e-4d14-a62e-16324b6a9a4f',
      },
      'route-acquire-operation',
    )
  })

  it('registers bounded nearby and actor-owned pending inbox routes', async () => {
    const nearbyCheckins = vi.fn().mockResolvedValue({
      policy: { version: 'v1', radiusMeters: 75, maxAgeSeconds: 60, maxAccuracyMeters: 50 },
      points: [],
    })
    const listPendingClaims = vi.fn().mockResolvedValue({ claims: [] })
    const listPendingFallbacks = vi.fn().mockResolvedValue({ fallbacks: [] })
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas(),
      createRaids({ nearbyCheckins, listPendingClaims, listPendingFallbacks }),
    )
    const raidId = '81297402-898c-48d6-bc78-c74b6b38205c'
    const nearby = await app.inject({
      method: 'GET',
      url: `/api/raids/${raidId}/check-ins/nearby?latitude=56.85&longitude=53.2&limit=5`,
      headers: { cookie: 'kabanda_session=session' },
    })
    expect(nearby.statusCode).toBe(200)
    expect(nearbyCheckins).toHaveBeenCalledWith(user.id, raidId, {
      latitude: 56.85,
      longitude: 53.2,
      limit: 5,
    })
    for (const path of ['check-in-claims', 'check-in-fallbacks']) {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/raids/${raidId}/${path}?status=pending`,
            headers: { cookie: 'kabanda_session=session' },
          })
        ).statusCode,
      ).toBe(200)
    }
  })

  it('passes raw media bytes only through a capability-scoped upload route', async () => {
    const uploadMedia = vi.fn().mockResolvedValue({
      media: {
        id: '8bb14649-50b1-46f0-a137-ff8fd6cd82fc',
        state: 'ready',
        contentType: 'image/jpeg',
      },
    })
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas(),
      createRaids({ uploadMedia }),
    )
    const bytes = Buffer.from('actual-image-bytes')
    const response = await app.inject({
      method: 'PUT',
      url: '/api/raids/81297402-898c-48d6-bc78-c74b6b38205c/media/intents/8bb14649-50b1-46f0-a137-ff8fd6cd82fc/content',
      headers: {
        origin: testOrigin,
        cookie: 'kabanda_session=session',
        'content-type': 'image/jpeg',
        'x-upload-capability': 'capability-that-is-long-enough-for-upload',
        'x-content-sha256': 'a'.repeat(64),
      },
      payload: bytes,
    })
    expect(response.statusCode).toBe(200)
    expect(uploadMedia).toHaveBeenCalledWith(
      user.id,
      '81297402-898c-48d6-bc78-c74b6b38205c',
      '8bb14649-50b1-46f0-a137-ff8fd6cd82fc',
      'capability-that-is-long-enough-for-upload',
      'a'.repeat(64),
      bytes,
    )
  })

  it('registers exact finish, settle and leave command DTOs', async () => {
    const finishRaid = vi.fn().mockResolvedValue({ raid: {}, finalization: {} })
    const settleFinalization = vi.fn().mockResolvedValue({ raid: {}, result: {} })
    const leaveRaid = vi.fn().mockResolvedValue({ raid: {} })
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas(),
      createRaids({ finishRaid, settleFinalization, leaveRaid }),
    )
    const raidId = '81297402-898c-48d6-bc78-c74b6b38205c'
    const commonHeaders = {
      origin: testOrigin,
      cookie: 'kabanda_session=session',
      'idempotency-key': 'finalization-operation',
    }
    const finish = await app.inject({
      method: 'POST',
      url: `/api/raids/${raidId}/commands/finish`,
      headers: commonHeaders,
      payload: {
        expectedVersion: 8,
        inventory: { routePending: 0, checkInsPending: 0, mediaPending: 0, needsAction: 1 },
        confirmPartial: true,
      },
    })
    expect(finish.statusCode).toBe(200)
    expect(finishRaid).toHaveBeenCalledWith(
      user.id,
      raidId,
      {
        expectedVersion: 8,
        inventory: { routePending: 0, checkInsPending: 0, mediaPending: 0, needsAction: 1 },
        confirmPartial: true,
      },
      'finalization-operation',
    )
    for (const [path, handler] of [
      ['finalization/settle', settleFinalization],
      ['participants/me/leave', leaveRaid],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/raids/${raidId}/${path}`,
        headers: { ...commonHeaders, 'idempotency-key': `operation-${path}` },
        payload: { expectedVersion: 9 },
      })
      expect(response.statusCode).toBe(200)
      expect(handler).toHaveBeenCalledWith(user.id, raidId, 9, `operation-${path}`)
    }
  })

  it('registers the atomic raid-template create, catalog, detail and cover routes', async () => {
    const kabandaId = 'c0e4f157-6a6d-43aa-a9ba-04aee1ff0f14'
    const templateId = '49b5f9ca-11fb-4474-a616-ddeec22445a6'
    const template: RaidTemplateProjection = {
      id: templateId,
      scope: 'kabanda',
      kabandaId,
      title: 'Набережные и мосты',
      version: 1,
      cover: {
        url: `/api/raid-templates/${templateId}/cover`,
        sha256: 'a'.repeat(64),
        width: 1_280,
        height: 720,
      },
      pointCount: 2,
      estimate: {
        method: 'straight_segments',
        distanceMeters: 1_269,
      },
      points: [
        {
          id: '3497db55-dfb9-4820-8fa5-c16932fc3c5c',
          position: 0,
          name: 'Старт',
          address: 'Улица Первая, 1',
          comment: '',
          latitude: 56.85,
          longitude: 53.2,
        },
        {
          id: 'f33da1a3-e7fc-4d10-bcc8-17417c3eb1e1',
          position: 1,
          name: 'Финиш',
          address: 'Улица Вторая, 2',
          comment: 'Собираемся у входа',
          latitude: 56.86,
          longitude: 53.21,
        },
      ],
      createdAt: '2026-09-01T08:01:00.000Z',
      updatedAt: '2026-09-01T08:01:00.000Z',
    }
    const createTemplate = vi.fn().mockResolvedValue({
      receipt: {
        operationId: 'template-operation',
        command: 'create-raid-template',
        resultingVersion: 1,
        serverAt: template.createdAt,
      },
      template,
    })
    const listTemplates = vi.fn().mockResolvedValue([{ ...template, points: undefined }])
    const getTemplate = vi.fn().mockResolvedValue(template)
    const readCover = vi.fn().mockResolvedValue({
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      contentType: 'image/jpeg',
      sha256: 'a'.repeat(64),
    })
    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas(),
      undefined,
      {
        raidTemplates: createRaidTemplates({
          createTemplate,
          listTemplates,
          getTemplate,
          readCover,
        }),
      },
    )
    const input = {
      title: ' Набережные и мосты ',
      coverImage: `data:image/jpeg;base64,${'A'.repeat(140_000)}`,
      points: template.points.map(({ name, address, comment, latitude, longitude }) => ({
        name,
        address,
        comment,
        latitude,
        longitude,
      })),
    }
    const created = await app.inject({
      method: 'POST',
      url: `/api/kabandas/${kabandaId}/raid-templates`,
      headers: {
        origin: testOrigin,
        cookie: 'kabanda_session=session',
        'idempotency-key': 'template-operation',
      },
      payload: input,
    })
    expect(created.statusCode).toBe(201)
    expect(created.headers['cache-control']).toBe('private, no-store')
    expect(createTemplate).toHaveBeenCalledWith(
      user.id,
      kabandaId,
      { ...input, scope: 'kabanda', title: 'Набережные и мосты' },
      'template-operation',
    )

    const catalog = await app.inject({
      method: 'GET',
      url: `/api/kabandas/${kabandaId}/raid-templates`,
      headers: { cookie: 'kabanda_session=session' },
    })
    expect(catalog.statusCode).toBe(200)
    expect(catalog.headers['cache-control']).toBe('private, no-store')
    expect(listTemplates).toHaveBeenCalledWith(user.id, kabandaId)

    const detail = await app.inject({
      method: 'GET',
      url: `/api/raid-templates/${templateId}`,
      headers: { cookie: 'kabanda_session=session' },
    })
    expect(detail.json()).toEqual({ template })
    expect(getTemplate).toHaveBeenCalledWith(user.id, templateId)

    const cover = await app.inject({
      method: 'GET',
      url: `/api/raid-templates/${templateId}/cover`,
      headers: { cookie: 'kabanda_session=session' },
    })
    expect(cover.statusCode).toBe(200)
    expect(cover.headers['content-type']).toMatch(/^image\/jpeg/)
    expect(cover.headers.etag).toBe(`"${'a'.repeat(64)}"`)
    expect(cover.rawPayload).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    expect(readCover).toHaveBeenCalledWith(user.id, templateId)
  })

  it('bounds raid-template writes and preserves not-found authorization semantics', async () => {
    const kabandaId = 'c0e4f157-6a6d-43aa-a9ba-04aee1ff0f14'
    const createTemplate = vi.fn()
    const listTemplates = vi.fn().mockRejectedValue(
      new RaidTemplateError('RAID_TEMPLATE_NOT_FOUND', 404, 'Шаблон рейда не найден'),
    )
    const service = createRaidTemplates({ createTemplate, listTemplates })
    const anonymousApp = await createTestApp(createAuth(), createKabandas(), undefined, {
      raidTemplates: service,
    })
    const anonymous = await anonymousApp.inject({
      method: 'GET',
      url: `/api/kabandas/${kabandaId}/raid-templates`,
    })
    expect(anonymous.statusCode).toBe(401)
    expect(listTemplates).not.toHaveBeenCalled()

    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas(),
      undefined,
      { raidTemplates: service },
    )
    const headers = {
      origin: testOrigin,
      cookie: 'kabanda_session=session',
      'idempotency-key': 'template-operation',
    }
    const point = {
      name: 'Точка',
      address: 'Адрес',
      comment: '',
      latitude: 56.85,
      longitude: 53.2,
    }
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/kabandas/${kabandaId}/raid-templates`,
      headers,
      payload: {
        title: 'Слишком много точек',
        coverImage: 'data:image/jpeg;base64,AAAA',
        points: Array.from({ length: 11 }, () => point),
      },
    })
    expect(invalid.statusCode).toBe(400)
    expect(createTemplate).not.toHaveBeenCalled()

    const legacyClientEstimate = await app.inject({
      method: 'POST',
      url: `/api/kabandas/${kabandaId}/raid-templates`,
      headers,
      payload: {
        title: 'Маршрут без сохраняемой оценки Яндекса',
        coverImage: 'data:image/jpeg;base64,AAAA',
        points: [point, { ...point, longitude: 53.21 }],
        estimate: {
          status: 'ready',
          mode: 'bicycle',
          distanceMeters: 8_400,
          computedAt: '2026-09-01T08:00:00.000Z',
        },
      },
    })
    expect(legacyClientEstimate.statusCode).toBe(400)
    expect(createTemplate).not.toHaveBeenCalled()

    const oversized = await app.inject({
      method: 'POST',
      url: `/api/kabandas/${kabandaId}/raid-templates`,
      headers,
      payload: {
        title: 'Слишком большая обложка',
        coverImage: `data:image/jpeg;base64,${'A'.repeat(800_000)}`,
        points: [point, point],
      },
    })
    expect(oversized.statusCode).toBe(413)

    createTemplate.mockRejectedValueOnce(new RaidTemplateError(
      'RAID_TEMPLATE_LIMIT_REACHED',
      409,
      'В Кабанде может быть не больше 100 маршрутов',
      { maximum: 100 },
    ))
    const atLimit = await app.inject({
      method: 'POST',
      url: `/api/kabandas/${kabandaId}/raid-templates`,
      headers,
      payload: {
        title: 'Маршрут 101',
        coverImage: 'data:image/jpeg;base64,AAAA',
        points: [point, { ...point, longitude: 53.21 }],
      },
    })
    expect(atLimit.statusCode).toBe(409)
    expect(atLimit.json()).toMatchObject({
      error: {
        code: 'RAID_TEMPLATE_LIMIT_REACHED',
        message: 'В Кабанде может быть не больше 100 маршрутов',
        details: { maximum: 100 },
      },
    })

    const hidden = await app.inject({
      method: 'GET',
      url: `/api/kabandas/${kabandaId}/raid-templates`,
      headers: { cookie: 'kabanda_session=session' },
    })
    expect(hidden.statusCode).toBe(404)
    expect(hidden.json().error.code).toBe('RAID_TEMPLATE_NOT_FOUND')
  })

  it('keeps reverse geocoding authenticated, inside Izhevsk and response-bounded', async () => {
    const reverse = vi.fn().mockResolvedValue({
      name: 'Ротонда',
      address: 'Набережная, Ижевск',
      source: 'openstreetmap',
    })
    const anonymousApp = await createTestApp(createAuth(), createKabandas(), undefined, {
      geocoding: { reverse },
    })
    const anonymous = await anonymousApp.inject({
      method: 'GET',
      url: '/api/geocoding/reverse?latitude=56.85&longitude=53.2',
    })
    expect(anonymous.statusCode).toBe(401)
    expect(reverse).not.toHaveBeenCalled()

    const app = await createTestApp(
      createAuth({ getUser: vi.fn().mockResolvedValue(user) }),
      createKabandas(),
      undefined,
      { geocoding: { reverse } },
    )
    const outsideIzhevsk = await app.inject({
      method: 'GET',
      url: '/api/geocoding/reverse?latitude=55.75&longitude=37.62',
      headers: { cookie: 'kabanda_session=session' },
    })
    expect(outsideIzhevsk.statusCode).toBe(400)
    expect(reverse).not.toHaveBeenCalled()

    const response = await app.inject({
      method: 'GET',
      url: '/api/geocoding/reverse?latitude=56.85&longitude=53.2',
      headers: { cookie: 'kabanda_session=session' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.json()).toEqual({
      name: 'Ротонда',
      address: 'Набережная, Ижевск',
      source: 'openstreetmap',
    })
    expect(reverse).toHaveBeenCalledWith(56.85, 53.2)

    reverse.mockRejectedValueOnce(new GeocodingError(
      'GEOCODING_PROVIDER_UNAVAILABLE',
      503,
      'Не удалось определить адрес. Введите его вручную',
    ))
    const unavailable = await app.inject({
      method: 'GET',
      url: '/api/geocoding/reverse?latitude=56.86&longitude=53.21',
      headers: { cookie: 'kabanda_session=session' },
    })
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.json().error.code).toBe('GEOCODING_PROVIDER_UNAVAILABLE')
  })
})
