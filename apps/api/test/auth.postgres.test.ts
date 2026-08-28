import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { createPasswordHash, DatabaseAuthService } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
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
})
