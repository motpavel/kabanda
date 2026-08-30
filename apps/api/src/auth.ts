import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { User } from '@kabanda/contracts'
import { normalizeEmail, sanitizeReturnTo } from '@kabanda/domain'
import type { Pool } from 'pg'
import type { ApiConfig } from './config.js'
import type { MagicLinkMailer } from './mailer.js'
import {
  acquireAlphaIdentityLock,
  alphaEmailFingerprint,
  isAlphaAccessGranted,
  isAlphaUserAccessGranted,
} from './alpha-access.js'

export interface VerifiedSession {
  rawToken: string
  returnTo: string
  user: User
}

export interface AuthService {
  requestMagicLink(email: string, returnTo: string): Promise<void>
  verifyMagicLink(rawToken: string): Promise<VerifiedSession | null>
  loginWithPassword(username: string, password: string): Promise<VerifiedSession | null>
  getUser(rawSessionToken: string): Promise<User | null>
  updateProfile(
    rawSessionToken: string,
    profile: { displayName: string; avatarUrl?: string | null | undefined },
  ): Promise<User | null>
  revokeSession(rawSessionToken: string): Promise<void>
}

type UserRow = {
  id: string
  email: string | null
  username: string | null
  identity_kind: 'verified' | 'invite'
  display_name: string | null
  avatar_url: string | null
  password_hash?: string | null
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    identityKind: row.identity_kind,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  }
}

const passwordKeyLength = 32
const passwordCost = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const

function derivePasswordKey(
  password: string,
  salt: Buffer,
  cost: { N: number; r: number; p: number; maxmem: number } = passwordCost,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, passwordKeyLength, cost, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

export async function createPasswordHash(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derivePasswordKey(password, salt)
  return `scrypt$v1$${passwordCost.N}$${passwordCost.r}$${passwordCost.p}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  const parts = encoded?.split('$') ?? []
  const N = Number(parts[2])
  const r = Number(parts[3])
  const p = Number(parts[4])
  const candidateSalt = parts[5] ? Buffer.from(parts[5], 'base64url') : Buffer.alloc(0)
  const candidateKey = parts[6] ? Buffer.from(parts[6], 'base64url') : Buffer.alloc(0)
  const validFormat = parts.length === 7 && parts[0] === 'scrypt' && parts[1] === 'v1'
    && (N === 16_384 || N === 32_768) && r === 8 && p === 1
    && candidateSalt.length === 16 && candidateKey.length === passwordKeyLength
  const salt = validFormat ? candidateSalt : Buffer.from('kabanda-invalid-login')
  const expected = validFormat ? candidateKey : Buffer.alloc(passwordKeyLength)
  const actual = await derivePasswordKey(password, salt, {
    N: validFormat ? N : passwordCost.N,
    r: validFormat ? r : passwordCost.r,
    p: validFormat ? p : passwordCost.p,
    maxmem: passwordCost.maxmem,
  })
  return expected.length === actual.length && timingSafeEqual(expected, actual)
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

    const client = await this.pool.connect()
    let allowed = true
    try {
      await client.query('BEGIN')
      if (this.config.ALPHA_ACCESS_MODE === 'enforced') {
        const secret = this.config.ALPHA_ACCESS_SECRET!
        const fingerprint = alphaEmailFingerprint(email, secret)
        await acquireAlphaIdentityLock(client, fingerprint)
        allowed = await isAlphaAccessGranted(client, email, secret)
      }
      if (allowed) {
        await client.query(
          `INSERT INTO auth_magic_links (token_hash, email, return_to, expires_at)
           VALUES ($1, $2, $3, now() + ($4 * interval '1 minute'))`,
          [tokenHash, email, returnTo, this.config.MAGIC_LINK_TTL_MINUTES],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    if (!allowed) return

    await this.mailer.sendMagicLink(
      email,
      buildMagicLinkVerificationUrl(this.config.APP_ORIGIN, rawToken, this.config.APP_BASE_PATH),
    )
  }

  async verifyMagicLink(rawToken: string): Promise<VerifiedSession | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const candidateResult = await client.query<{ email: string; return_to: string }>(
        `SELECT email, return_to FROM auth_magic_links
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
        [hashToken(rawToken)],
      )
      const candidate = candidateResult.rows[0]
      if (!candidate) {
        await client.query('ROLLBACK')
        return null
      }
      if (this.config.ALPHA_ACCESS_MODE === 'enforced') {
        const secret = this.config.ALPHA_ACCESS_SECRET!
        const fingerprint = alphaEmailFingerprint(candidate.email, secret)
        await acquireAlphaIdentityLock(client, fingerprint)
        if (!(await isAlphaAccessGranted(client, candidate.email, secret))) {
          await client.query(
            `UPDATE auth_magic_links SET consumed_at = now()
             WHERE token_hash = $1 AND consumed_at IS NULL`,
            [hashToken(rawToken)],
          )
          await client.query('COMMIT')
          return null
        }
      }
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
         RETURNING id, email, username, identity_kind, display_name, avatar_url`,
        [link.email],
      )
      const userRow = userResult.rows[0]
      if (!userRow) throw new Error('User was not returned after upsert')

      if (this.config.ALPHA_ACCESS_MODE === 'enforced') {
        const linkedGrant = await client.query(
          `UPDATE alpha_access_grants
           SET user_id = $1, updated_at = now()
           WHERE email_fingerprint = $2 AND status = 'active'
             AND (user_id IS NULL OR user_id = $1)`,
          [userRow.id, alphaEmailFingerprint(link.email, this.config.ALPHA_ACCESS_SECRET!)],
        )
        if (linkedGrant.rowCount !== 1) throw new Error('Closed-alpha grant identity mismatch')
      }

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

  async loginWithPassword(username: string, password: string): Promise<VerifiedSession | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query<UserRow>(
        `SELECT id, email, username, identity_kind, display_name, avatar_url, password_hash
         FROM users
         WHERE username = $1 AND identity_kind = 'invite'
         FOR SHARE`,
        [username],
      )
      const row = result.rows[0]
      if (!(await verifyPassword(password, row?.password_hash ?? null)) || !row) {
        await client.query('ROLLBACK')
        return null
      }
      if (
        this.config.ALPHA_ACCESS_MODE === 'enforced' &&
        !(await isAlphaUserAccessGranted(client, row.id))
      ) {
        await client.query('ROLLBACK')
        return null
      }
      const rawSessionToken = randomBytes(32).toString('base64url')
      await client.query(
        `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
         VALUES ($1, $2, now() + ($3 * interval '1 day'))`,
        [hashToken(rawSessionToken), row.id, this.config.SESSION_TTL_DAYS],
      )
      await client.query('COMMIT')
      return { rawToken: rawSessionToken, returnTo: '/', user: toUser(row) }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async getUser(rawSessionToken: string): Promise<User | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT users.id, users.email, users.username, users.identity_kind,
         users.display_name, users.avatar_url
       FROM auth_sessions
       JOIN users ON users.id = auth_sessions.user_id
       WHERE auth_sessions.token_hash = $1 AND auth_sessions.expires_at > now()`,
      [hashToken(rawSessionToken)],
    )
    const row = result.rows[0]
    if (!row) return null
    if (
      this.config.ALPHA_ACCESS_MODE === 'enforced' &&
      !(await isAlphaUserAccessGranted(this.pool, row.id))
    ) return null
    return toUser(row)
  }

  async updateProfile(
    rawSessionToken: string,
    profile: { displayName: string; avatarUrl?: string | null | undefined },
  ): Promise<User | null> {
    if (!(await this.getUser(rawSessionToken))) return null
    const result = await this.pool.query<UserRow>(
      `UPDATE users
       SET display_name = $2, avatar_url = $3, updated_at = now()
       FROM auth_sessions
       WHERE auth_sessions.user_id = users.id
         AND auth_sessions.token_hash = $1
         AND auth_sessions.expires_at > now()
       RETURNING users.id, users.email, users.username, users.identity_kind,
         users.display_name, users.avatar_url`,
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
