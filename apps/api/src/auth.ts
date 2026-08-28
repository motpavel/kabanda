import { createHash, randomBytes } from 'node:crypto'
import type { User } from '@kabanda/contracts'
import { normalizeEmail, sanitizeReturnTo } from '@kabanda/domain'
import type { Pool } from 'pg'
import type { ApiConfig } from './config.js'
import type { MagicLinkMailer } from './mailer.js'

export interface VerifiedSession {
  rawToken: string
  returnTo: string
  user: User
}

export interface AuthService {
  requestMagicLink(email: string, returnTo: string): Promise<void>
  verifyMagicLink(rawToken: string): Promise<VerifiedSession | null>
  getUser(rawSessionToken: string): Promise<User | null>
  updateProfile(
    rawSessionToken: string,
    profile: { displayName: string; avatarUrl?: string | null | undefined },
  ): Promise<User | null>
  revokeSession(rawSessionToken: string): Promise<void>
}

type UserRow = {
  id: string
  email: string
  display_name: string | null
  avatar_url: string | null
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  }
}

export function buildMagicLinkVerificationUrl(
  appOrigin: string,
  rawToken: string,
  appBasePath = '/',
): string {
  const verifyUrl = new URL(`${appBasePath.replace(/^\/+/, '')}auth/verify`, `${appOrigin}/`)
  verifyUrl.hash = new URLSearchParams({ token: rawToken }).toString()
  return verifyUrl.toString()
}

export class DatabaseAuthService implements AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly mailer: MagicLinkMailer,
    private readonly config: ApiConfig,
  ) {}

  async requestMagicLink(emailInput: string, returnToInput: string): Promise<void> {
    const email = normalizeEmail(emailInput)
    const returnTo = sanitizeReturnTo(returnToInput)
    const rawToken = randomBytes(32).toString('base64url')
    const tokenHash = hashToken(rawToken)

    await this.pool.query(
      `INSERT INTO auth_magic_links (token_hash, email, return_to, expires_at)
       VALUES ($1, $2, $3, now() + ($4 * interval '1 minute'))`,
      [tokenHash, email, returnTo, this.config.MAGIC_LINK_TTL_MINUTES],
    )

    await this.mailer.sendMagicLink(
      email,
      buildMagicLinkVerificationUrl(this.config.APP_ORIGIN, rawToken, this.config.APP_BASE_PATH),
    )
  }

  async verifyMagicLink(rawToken: string): Promise<VerifiedSession | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const linkResult = await client.query<{ email: string; return_to: string }>(
        `UPDATE auth_magic_links
         SET consumed_at = now()
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
         RETURNING email, return_to`,
        [hashToken(rawToken)],
      )
      const link = linkResult.rows[0]
      if (!link) {
        await client.query('ROLLBACK')
        return null
      }

      const userResult = await client.query<UserRow>(
        `INSERT INTO users (email) VALUES ($1)
         ON CONFLICT (email) DO UPDATE SET updated_at = now()
         RETURNING id, email, display_name, avatar_url`,
        [link.email],
      )
      const userRow = userResult.rows[0]
      if (!userRow) throw new Error('User was not returned after upsert')

      const rawSessionToken = randomBytes(32).toString('base64url')
      await client.query(
        `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
         VALUES ($1, $2, now() + ($3 * interval '1 day'))`,
        [hashToken(rawSessionToken), userRow.id, this.config.SESSION_TTL_DAYS],
      )
      await client.query('COMMIT')
      return { rawToken: rawSessionToken, returnTo: link.return_to, user: toUser(userRow) }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async getUser(rawSessionToken: string): Promise<User | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT users.id, users.email, users.display_name, users.avatar_url
       FROM auth_sessions
       JOIN users ON users.id = auth_sessions.user_id
       WHERE auth_sessions.token_hash = $1 AND auth_sessions.expires_at > now()`,
      [hashToken(rawSessionToken)],
    )
    return result.rows[0] ? toUser(result.rows[0]) : null
  }

  async updateProfile(
    rawSessionToken: string,
    profile: { displayName: string; avatarUrl?: string | null | undefined },
  ): Promise<User | null> {
    const result = await this.pool.query<UserRow>(
      `UPDATE users
       SET display_name = $2, avatar_url = $3, updated_at = now()
       FROM auth_sessions
       WHERE auth_sessions.user_id = users.id
         AND auth_sessions.token_hash = $1
         AND auth_sessions.expires_at > now()
       RETURNING users.id, users.email, users.display_name, users.avatar_url`,
      [hashToken(rawSessionToken), profile.displayName, profile.avatarUrl ?? null],
    )
    return result.rows[0] ? toUser(result.rows[0]) : null
  }

  async revokeSession(rawSessionToken: string): Promise<void> {
    await this.pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [
      hashToken(rawSessionToken),
    ])
  }
}
