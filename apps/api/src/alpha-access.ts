import { createHmac } from 'node:crypto'
import { normalizeEmail } from '@kabanda/domain'
import type { Pool, PoolClient } from 'pg'

export const CLOSED_ALPHA_USER_CAP = 20

export class AlphaAccessError extends Error {
  constructor(
    readonly code:
      | 'ALPHA_ACCESS_CAP_REACHED'
      | 'ALPHA_ACCESS_GRANT_NOT_FOUND'
      | 'ALPHA_ACCESS_OPERATOR_CONTEXT_MISMATCH',
    message: string,
  ) {
    super(message)
    this.name = 'AlphaAccessError'
  }
}

type Queryable = Pool | PoolClient

type GrantRow = {
  id: string
  status: 'active' | 'revoked'
}

export type AlphaAccessStatus = {
  activeCount: number
  cap: typeof CLOSED_ALPHA_USER_CAP
  grantId: string | null
  status: 'active' | 'revoked' | 'missing'
}

export type AlphaAccessMutation = AlphaAccessStatus & {
  changed: boolean
  alreadyApplied: boolean
  linksInvalidated: number
  sessionsRevoked: number
}

export function alphaEmailFingerprint(emailInput: string, secret: string): string {
  if (secret.length < 32) throw new Error('Closed-alpha access secret must be at least 32 characters')
  return createHmac('sha256', secret).update(normalizeEmail(emailInput)).digest('hex')
}

export async function acquireAlphaIdentityLock(client: Queryable, emailFingerprint: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `kabanda-alpha-identity-v1:${emailFingerprint}`,
  ])
}

export async function acquireAlphaQuotaLock(client: Queryable): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('kabanda-alpha-quota-v1', 0))")
}

export async function activeAlphaAccessCount(client: Queryable): Promise<number> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM alpha_access_grants WHERE status = 'active'",
  )
  return Number(result.rows[0]?.count ?? 0)
}

async function grantByFingerprint(client: Queryable, fingerprint: string): Promise<GrantRow | null> {
  const result = await client.query<GrantRow>(
    'SELECT id, status FROM alpha_access_grants WHERE email_fingerprint = $1',
    [fingerprint],
  )
  return result.rows[0] ?? null
}

export async function isAlphaAccessGranted(
  client: Queryable,
  emailInput: string,
  secret: string,
): Promise<boolean> {
  const fingerprint = alphaEmailFingerprint(emailInput, secret)
  const result = await client.query(
    "SELECT 1 FROM alpha_access_grants WHERE email_fingerprint = $1 AND status = 'active'",
    [fingerprint],
  )
  return Boolean(result.rowCount)
}

export async function isAlphaUserAccessGranted(
  client: Queryable,
  userId: string,
): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM alpha_access_grants WHERE user_id = $1 AND status = 'active'",
    [userId],
  )
  return Boolean(result.rowCount)
}

export async function inspectAlphaAccess(
  pool: Pool,
  secret: string,
  emailInput?: string,
): Promise<AlphaAccessStatus> {
  const count = await activeAlphaAccessCount(pool)
  if (!emailInput) {
    return { activeCount: count, cap: CLOSED_ALPHA_USER_CAP, grantId: null, status: 'missing' }
  }
  const grant = await grantByFingerprint(pool, alphaEmailFingerprint(emailInput, secret))
  return {
    activeCount: count,
    cap: CLOSED_ALPHA_USER_CAP,
    grantId: grant?.id ?? null,
    status: grant?.status ?? 'missing',
  }
}

async function enrollAlphaAccessAttempt(
  pool: Pool,
  emailInput: string,
  secret: string,
): Promise<AlphaAccessMutation> {
  const fingerprint = alphaEmailFingerprint(emailInput, secret)
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    await acquireAlphaQuotaLock(client)
    await acquireAlphaIdentityLock(client, fingerprint)
    const existing = await grantByFingerprint(client, fingerprint)
    if (existing?.status === 'active') {
      const count = await activeAlphaAccessCount(client)
      await client.query('COMMIT')
      return {
        activeCount: count,
        cap: CLOSED_ALPHA_USER_CAP,
        grantId: existing.id,
        status: 'active',
        changed: false,
        alreadyApplied: true,
        linksInvalidated: 0,
        sessionsRevoked: 0,
      }
    }
    const count = await activeAlphaAccessCount(client)
    if (count >= CLOSED_ALPHA_USER_CAP) {
      throw new AlphaAccessError('ALPHA_ACCESS_CAP_REACHED', 'Closed-alpha access cap reached')
    }
    const email = normalizeEmail(emailInput)
    const result = await client.query<{ id: string }>(
      `INSERT INTO alpha_access_grants (email_fingerprint, user_id, status)
       VALUES ($1, (SELECT id FROM users WHERE email = $2), 'active')
       ON CONFLICT (email_fingerprint) DO UPDATE
         SET user_id = COALESCE(alpha_access_grants.user_id, EXCLUDED.user_id),
           status = 'active', granted_at = now(), revoked_at = NULL, updated_at = now()
       RETURNING id`,
      [fingerprint, email],
    )
    await client.query('COMMIT')
    return {
      activeCount: count + 1,
      cap: CLOSED_ALPHA_USER_CAP,
      grantId: result.rows[0]!.id,
      status: 'active',
      changed: true,
      alreadyApplied: false,
      linksInvalidated: 0,
      sessionsRevoked: 0,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function enrollAlphaAccess(
  pool: Pool,
  emailInput: string,
  secret: string,
): Promise<AlphaAccessMutation> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await enrollAlphaAccessAttempt(pool, emailInput, secret)
    } catch (error) {
      if ((error as { code?: string }).code !== '40001' || attempt === 2) throw error
    }
  }
  throw new Error('Closed-alpha enrollment retry exhausted')
}

export async function revokeAlphaAccess(
  pool: Pool,
  emailInput: string,
  secret: string,
): Promise<AlphaAccessMutation> {
  const email = normalizeEmail(emailInput)
  const fingerprint = alphaEmailFingerprint(email, secret)
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    await acquireAlphaQuotaLock(client)
    await acquireAlphaIdentityLock(client, fingerprint)
    const existing = await grantByFingerprint(client, fingerprint)
    if (!existing) {
      throw new AlphaAccessError('ALPHA_ACCESS_GRANT_NOT_FOUND', 'Closed-alpha access grant was not found')
    }
    const revoked = await client.query<{ id: string }>(
      `UPDATE alpha_access_grants
       SET status = 'revoked', revoked_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'active'
       RETURNING id`,
      [existing.id],
    )
    const links = await client.query(
      `UPDATE auth_magic_links
       SET consumed_at = now()
       WHERE email = $1 AND consumed_at IS NULL AND expires_at > now()`,
      [email],
    )
    const sessions = await client.query(
      `DELETE FROM auth_sessions s USING users u
       WHERE s.user_id = u.id AND u.email = $1`,
      [email],
    )
    const count = await activeAlphaAccessCount(client)
    await client.query('COMMIT')
    return {
      activeCount: count,
      cap: CLOSED_ALPHA_USER_CAP,
      grantId: existing.id,
      status: 'revoked',
      changed: Boolean(revoked.rowCount || links.rowCount || sessions.rowCount),
      alreadyApplied: !revoked.rowCount && !links.rowCount && !sessions.rowCount,
      linksInvalidated: links.rowCount ?? 0,
      sessionsRevoked: sessions.rowCount ?? 0,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function assertAlphaOperatorContext(
  pool: Pool,
  context: {
    expectedDatabase: string
    expectedApiBuild: string
    actualApiBuild: string
    expectedMigration: string
  },
): Promise<void> {
  if (!context.expectedDatabase || context.expectedApiBuild !== context.actualApiBuild) {
    throw new AlphaAccessError(
      'ALPHA_ACCESS_OPERATOR_CONTEXT_MISMATCH',
      'Closed-alpha operator context does not match the exact deployment',
    )
  }
  const result = await pool.query<{ database_name: string; migration_name: string | null }>(
    `SELECT current_database() AS database_name,
       (SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1) AS migration_name`,
  )
  const row = result.rows[0]
  if (
    row?.database_name !== context.expectedDatabase ||
    row.migration_name !== context.expectedMigration
  ) {
    throw new AlphaAccessError(
      'ALPHA_ACCESS_OPERATOR_CONTEXT_MISMATCH',
      'Closed-alpha operator context does not match the exact deployment',
    )
  }
}
