import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { createPasswordHash, DatabaseAuthService, verifyPassword } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import {
  CredentialResetError,
  inspectCredentialReset,
  resetCredential,
} from '../src/credential-reset.js'
import type { MagicLinkMailer } from '../src/mailer.js'

const databaseUrl = process.env.DATABASE_URL
const describePostgres = databaseUrl ? describe : describe.skip
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null

class CapturingMailer implements MagicLinkMailer {
  link: string | null = null

  async sendMagicLink(_email: string, link: string): Promise<void> {
    this.link = link
  }
}

describePostgres('PostgreSQL auth invariants', () => {
  beforeEach(async () => {
    await pool!.query('TRUNCATE auth_sessions, auth_magic_links, users CASCADE')
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('lets only one concurrent magic-link exchange create a session', async () => {
    const mailer = new CapturingMailer()
    const auth = new DatabaseAuthService(
      pool!,
      mailer,
      loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl }),
    )
    await auth.requestMagicLink('pavel@example.com', '/home')

    const token = new URLSearchParams(new URL(mailer.link!).hash.slice(1)).get('token')
    expect(token).toBeTruthy()

    const results = await Promise.all([auth.verifyMagicLink(token!), auth.verifyMagicLink(token!)])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(Number((await pool!.query('SELECT count(*) FROM auth_sessions')).rows[0]?.count)).toBe(1)
  })

  it('logs an invite identity in with a salted password hash and a generic failure', async () => {
    const auth = new DatabaseAuthService(
      pool!,
      new CapturingMailer(),
      loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl }),
    )
    await pool!.query(
      `INSERT INTO users (email, username, password_hash, identity_kind, display_name)
       VALUES (NULL, $1, $2, 'invite', $3)`,
      ['night-boar', await createPasswordHash('correct-password'), 'night-boar'],
    )
    await expect(auth.loginWithPassword('night-boar', 'wrong-password')).resolves.toBeNull()
    await expect(auth.loginWithPassword('missing-boar', 'wrong-password')).resolves.toBeNull()
    const session = await auth.loginWithPassword('NIGHT-BOAR', 'correct-password')
    expect(session?.user).toMatchObject({ username: 'night-boar', identityKind: 'invite', email: null })
    expect(Number((await pool!.query('SELECT count(*) FROM auth_sessions')).rows[0]?.count)).toBe(1)
  })

  it('resets one invite password, revokes its sessions and leaves another identity untouched', async () => {
    const auth = new DatabaseAuthService(
      pool!,
      new CapturingMailer(),
      loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl }),
    )
    await pool!.query(
      `INSERT INTO users (email, username, password_hash, identity_kind, display_name)
       VALUES
         (NULL, $1, $2, 'invite', $5),
         (NULL, $3, $4, 'invite', $6)`,
      [
        'reset-boar',
        await createPasswordHash('old-password'),
        'other-boar',
        await createPasswordHash('other-password'),
        'reset-boar',
        'other-boar',
      ],
    )
    const targetSession = await auth.loginWithPassword('reset-boar', 'old-password')
    const otherSession = await auth.loginWithPassword('other-boar', 'other-password')
    await expect(inspectCredentialReset(pool!, 'RESET-BOAR')).resolves.toMatchObject({
      identityKind: 'invite',
      credentialConfigured: true,
      activeSessions: 1,
    })

    await expect(resetCredential(pool!, 'reset-boar', 'new-password')).resolves.toMatchObject({
      changed: true,
      sessionsRevoked: 1,
      activeSessions: 0,
    })
    await expect(auth.getUser(targetSession!.rawToken)).resolves.toBeNull()
    await expect(auth.getUser(otherSession!.rawToken)).resolves.toMatchObject({ username: 'other-boar' })
    await expect(auth.loginWithPassword('reset-boar', 'old-password')).resolves.toBeNull()
    await expect(auth.loginWithPassword('reset-boar', 'new-password')).resolves.toMatchObject({
      user: { username: 'reset-boar' },
    })
    const stored = await pool!.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE username = $1',
      ['reset-boar'],
    )
    expect(stored.rows[0]?.password_hash).not.toBe('new-password')
    await expect(verifyPassword('new-password', stored.rows[0]?.password_hash ?? null)).resolves.toBe(true)
  })

  it('fails closed for a missing or non-invite credential identity', async () => {
    await pool!.query(
      `INSERT INTO users (email, username, identity_kind, display_name)
       VALUES ('owner@example.com', 'owner-boar', 'verified', 'Owner')`,
    )
    await expect(resetCredential(pool!, 'missing-boar', 'new-password')).rejects.toMatchObject({
      code: 'CREDENTIAL_IDENTITY_NOT_FOUND',
    })
    await expect(resetCredential(pool!, 'owner-boar', 'new-password')).rejects.toEqual(
      expect.objectContaining<Partial<CredentialResetError>>({
        code: 'CREDENTIAL_IDENTITY_UNSUPPORTED',
      }),
    )
    expect(Number((await pool!.query('SELECT count(*) FROM auth_sessions')).rows[0]?.count)).toBe(0)
  })

  it('does not leave an old-password session alive when login races with reset', async () => {
    const auth = new DatabaseAuthService(
      pool!,
      new CapturingMailer(),
      loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl }),
    )
    await pool!.query(
      `INSERT INTO users (email, username, password_hash, identity_kind, display_name)
       VALUES (NULL, $1, $2, 'invite', $3)`,
      ['race-boar', await createPasswordHash('old-password'), 'race-boar'],
    )

    const [oldLogin] = await Promise.all([
      auth.loginWithPassword('race-boar', 'old-password'),
      resetCredential(pool!, 'race-boar', 'new-password'),
    ])
    if (oldLogin) await expect(auth.getUser(oldLogin.rawToken)).resolves.toBeNull()
    expect(Number((await pool!.query(
      `SELECT count(*) FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE u.username = $1`,
      ['race-boar'],
    )).rows[0]?.count)).toBe(0)
    await expect(auth.loginWithPassword('race-boar', 'new-password')).resolves.not.toBeNull()
  })
})
