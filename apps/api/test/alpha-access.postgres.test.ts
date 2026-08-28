import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import {
  AlphaAccessError,
  CLOSED_ALPHA_USER_CAP,
  alphaEmailFingerprint,
  enrollAlphaAccess,
  inspectAlphaAccess,
  revokeAlphaAccess,
} from '../src/alpha-access.js'
import { applyAlphaRollback } from '../src/alpha-rollback.js'
import { DatabaseAuthService } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import { DatabaseKabandaService } from '../src/kabandas.js'
import type { MagicLinkMailer } from '../src/mailer.js'

const databaseUrl = process.env.DATABASE_URL
const describePostgres = databaseUrl ? describe : describe.skip
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null
const secret = 'closed-alpha-test-secret-that-is-at-least-32-bytes'

class CapturingMailer implements MagicLinkMailer {
  messages: Array<{ email: string; link: string }> = []

  async sendMagicLink(email: string, link: string): Promise<void> {
    this.messages.push({ email, link })
  }
}

function auth(mailer: CapturingMailer) {
  return new DatabaseAuthService(
    pool!,
    mailer,
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      ALPHA_ACCESS_MODE: 'enforced',
      ALPHA_ACCESS_SECRET: secret,
    }),
  )
}

function magicToken(link: string): string {
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token')
  if (!token) throw new Error('Magic link contained no token')
  return token
}

async function createUser(email: string): Promise<string> {
  const result = await pool!.query<{ id: string }>(
    'INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id',
    [email, email.split('@')[0]],
  )
  return result.rows[0]!.id
}

async function createSession(userId: string, label: string): Promise<void> {
  await pool!.query(
    `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + interval '1 day')`,
    [createHash('sha256').update(label).digest('hex'), userId],
  )
}

describePostgres('closed-alpha access and rollback', () => {
  beforeEach(async () => {
    await pool!.query(
      'TRUNCATE alpha_rollback_reports, alpha_access_grants, auth_sessions, auth_magic_links, users CASCADE',
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('keeps magic-link responses non-enumerating and issues a token only to an active grant', async () => {
    const mailer = new CapturingMailer()
    const service = auth(mailer)

    await expect(service.requestMagicLink('closed@example.com', '/app')).resolves.toBeUndefined()
    expect(mailer.messages).toHaveLength(0)
    expect(Number((await pool!.query('SELECT count(*) FROM auth_magic_links')).rows[0]?.count)).toBe(0)

    await enrollAlphaAccess(pool!, 'open@example.com', secret)
    await expect(service.requestMagicLink('open@example.com', '/app')).resolves.toBeUndefined()
    expect(mailer.messages).toHaveLength(1)
    expect(Number((await pool!.query('SELECT count(*) FROM auth_magic_links')).rows[0]?.count)).toBe(1)
  })

  it('rechecks enrollment at exchange and revoke invalidates exact links and sessions only', async () => {
    const mailer = new CapturingMailer()
    const service = auth(mailer)
    await enrollAlphaAccess(pool!, 'target@example.com', secret)
    await enrollAlphaAccess(pool!, 'unrelated@example.com', secret)
    await service.requestMagicLink('target@example.com', '/app')
    await service.requestMagicLink('unrelated@example.com', '/app')
    const targetToken = magicToken(mailer.messages[0]!.link)
    const unrelatedToken = magicToken(mailer.messages[1]!.link)
    const unrelatedSession = await service.verifyMagicLink(unrelatedToken)
    expect(unrelatedSession).not.toBeNull()

    const revoked = await revokeAlphaAccess(pool!, 'target@example.com', secret)
    expect(revoked).toMatchObject({ changed: true, status: 'revoked', linksInvalidated: 1 })
    await expect(service.verifyMagicLink(targetToken)).resolves.toBeNull()
    expect(await service.getUser(unrelatedSession!.rawToken)).toMatchObject({ email: 'unrelated@example.com' })
    await expect(revokeAlphaAccess(pool!, 'target@example.com', secret)).resolves.toMatchObject({
      changed: false,
      alreadyApplied: true,
    })
  })

  it('serializes concurrent enrollment at the hard 20-user cap', async () => {
    const fingerprints = Array.from({ length: CLOSED_ALPHA_USER_CAP - 1 }, (_, index) =>
      alphaEmailFingerprint(`alpha-${index}@example.com`, secret))
    await pool!.query(
      `INSERT INTO alpha_access_grants (email_fingerprint, status)
       SELECT fingerprint, 'active' FROM unnest($1::text[]) AS fingerprint`,
      [fingerprints],
    )
    const attempts = await Promise.allSettled([
      enrollAlphaAccess(pool!, 'last-a@example.com', secret),
      enrollAlphaAccess(pool!, 'last-b@example.com', secret),
    ])
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const rejected = attempts.find(({ status }) => status === 'rejected')
    expect(rejected?.status === 'rejected' ? rejected.reason : null).toBeInstanceOf(AlphaAccessError)
    expect(await inspectAlphaAccess(pool!, secret)).toMatchObject({ activeCount: 20, cap: 20 })
  })

  it('archives only an exact dedicated Kabanda, revokes access and retains immutable results', async () => {
    const kabandas = new DatabaseKabandaService(pool!)
    const ownerEmail = 'rollback-owner@example.com'
    const memberEmail = 'rollback-member@example.com'
    const ownerId = await createUser(ownerEmail)
    const memberId = await createUser(memberEmail)
    const unrelatedId = await createUser('rollback-unrelated@example.com')
    const target = await kabandas.createKabanda(ownerId, 'Rollback target', '🐗', 'rollback-target')
    const unrelated = await kabandas.createKabanda(unrelatedId, 'Unrelated', '🌲', 'rollback-unrelated')
    await pool!.query(
      "INSERT INTO kabanda_memberships (kabanda_id, user_id, role) VALUES ($1, $2, 'member')",
      [target.id, memberId],
    )
    await enrollAlphaAccess(pool!, ownerEmail, secret)
    await enrollAlphaAccess(pool!, memberEmail, secret)
    await enrollAlphaAccess(pool!, 'rollback-unrelated@example.com', secret)
    await Promise.all([
      createSession(ownerId, 'owner-session'),
      createSession(memberId, 'member-session'),
      createSession(unrelatedId, 'unrelated-session'),
    ])
    await pool!.query(
      `INSERT INTO auth_magic_links (token_hash, email, return_to, expires_at)
       VALUES ($1, $2, '/app', now() + interval '15 minutes')`,
      [createHash('sha256').update('owner-link').digest('hex'), ownerEmail],
    )
    await kabandas.createInvite(ownerId, target.id, 1)
    const raidId = randomUUID()
    await pool!.query(
      `INSERT INTO raids
         (id, kabanda_id, organizer_user_id, title, state, started_at, finalizing_at,
          finalization_deadline_at, completed_at)
       VALUES ($1, $2, $3, 'Completed alpha', 'completed', now() - interval '1 hour',
         now() - interval '1 minute', now(), now())`,
      [raidId, target.id, ownerId],
    )
    await pool!.query(
      `INSERT INTO raid_results
         (raid_id, kabanda_id, schema_version, partial, started_at, completed_at,
          team_duration_seconds, team_distance_meters, team_unique_points, team_photos,
          result_json, share_png, share_sha256)
       VALUES ($1, $2, 1, false, now() - interval '1 hour', now(), 3600, 1000, 1, 1,
         '{}', $3, $4)`,
      [raidId, target.id, Buffer.alloc(64, 1), 'a'.repeat(64)],
    )

    const input = { kabandaId: target.id, ownerEmail, expectedApiBuild: 'build-a', secret }
    const applied = await applyAlphaRollback(pool!, input)
    expect(applied).toMatchObject({
      changed: true,
      alreadyApplied: false,
      memberCount: 2,
      grantsRevoked: 2,
      retainedResults: 1,
    })
    await expect(applyAlphaRollback(pool!, input)).resolves.toEqual({
      ...applied,
      changed: false,
      alreadyApplied: true,
    })
    expect((await kabandas.listKabandas(ownerId)).map(({ id }) => id)).not.toContain(target.id)
    await expect(kabandas.listMembers(ownerId, target.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await kabandas.listKabandas(unrelatedId)).map(({ id }) => id)).toContain(unrelated.id)
    expect(Number((await pool!.query('SELECT count(*) FROM auth_sessions')).rows[0]?.count)).toBe(1)
    expect(Number((await pool!.query('SELECT count(*) FROM raid_results WHERE raid_id = $1', [raidId])).rows[0]?.count)).toBe(1)
  })

  it('blocks a concurrent external membership after grant locks and keeps it out of the rollback scope', async () => {
    const kabandas = new DatabaseKabandaService(pool!)
    const ownerEmail = 'race-owner@example.com'
    const ownerId = await createUser(ownerEmail)
    const otherOwnerId = await createUser('race-other@example.com')
    const target = await kabandas.createKabanda(ownerId, 'Race target', '🐗', 'race-target')
    const external = await kabandas.createKabanda(otherOwnerId, 'Race external', '🌲', 'race-external')
    await enrollAlphaAccess(pool!, ownerEmail, secret)
    await createSession(ownerId, 'race-session')
    const input = { kabandaId: target.id, ownerEmail, expectedApiBuild: 'build-a', secret }
    let releaseExternalInsert!: () => void
    const externalInsertGate = new Promise<void>((resolve) => {
      releaseExternalInsert = resolve
    })
    const externalInsert = externalInsertGate.then(() => pool!.query(
      "INSERT INTO kabanda_memberships (kabanda_id, user_id, role) VALUES ($1, $2, 'member')",
      [external.id, ownerId],
    ).then(() => ({ error: null }), (error: unknown) => ({ error })))
    const rollback = applyAlphaRollback(pool!, input, {
      afterGrantLocks: async () => {
        releaseExternalInsert()
        await new Promise((resolve) => setTimeout(resolve, 100))
      },
    })
    await expect(rollback).resolves.toMatchObject({ changed: true, sessionsRevoked: 1 })
    expect((await externalInsert).error).toMatchObject({ code: '42501' })
    expect(Number((await pool!.query('SELECT count(*) FROM auth_sessions WHERE user_id = $1', [ownerId])).rows[0]?.count)).toBe(0)
    expect(Number((await pool!.query('SELECT count(*) FROM kabanda_memberships WHERE kabanda_id = $1 AND user_id = $2', [external.id, ownerId])).rows[0]?.count)).toBe(0)
  })
})
