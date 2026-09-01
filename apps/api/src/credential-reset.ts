import { passwordSchema } from '@kabanda/contracts'
import type { Pool, PoolClient } from 'pg'
import { createPasswordHash } from './auth.js'

export class CredentialResetError extends Error {
  constructor(
    readonly code: 'CREDENTIAL_IDENTITY_NOT_FOUND' | 'CREDENTIAL_IDENTITY_UNSUPPORTED',
    message: string,
  ) {
    super(message)
    this.name = 'CredentialResetError'
  }
}

type CredentialRow = {
  id: string
  identity_kind: 'verified' | 'invite'
  credential_configured: boolean
  active_sessions: string
}

export type CredentialResetStatus = {
  userId: string
  identityKind: 'invite'
  credentialConfigured: boolean
  activeSessions: number
}

export type CredentialResetMutation = CredentialResetStatus & {
  changed: true
  sessionsRevoked: number
}

async function findCredential(
  client: Pool | PoolClient,
  username: string,
  lock = false,
): Promise<CredentialRow> {
  const result = await client.query<CredentialRow>(
    `SELECT u.id, u.identity_kind, (u.password_hash IS NOT NULL) AS credential_configured,
       (SELECT count(*)::text FROM auth_sessions s
        WHERE s.user_id = u.id AND s.expires_at > now()) AS active_sessions
     FROM users u
     WHERE u.username = $1
     ${lock ? 'FOR UPDATE OF u' : ''}`,
    [username],
  )
  const row = result.rows[0]
  if (!row) {
    throw new CredentialResetError(
      'CREDENTIAL_IDENTITY_NOT_FOUND',
      'Credential identity was not found',
    )
  }
  if (row.identity_kind !== 'invite') {
    throw new CredentialResetError(
      'CREDENTIAL_IDENTITY_UNSUPPORTED',
      'Only invite identities can use operator credential reset',
    )
  }
  return row
}

function toStatus(row: CredentialRow): CredentialResetStatus {
  return {
    userId: row.id,
    identityKind: 'invite',
    credentialConfigured: row.credential_configured,
    activeSessions: Number(row.active_sessions),
  }
}

export async function inspectCredentialReset(
  pool: Pool,
  username: string,
): Promise<CredentialResetStatus> {
  return toStatus(await findCredential(pool, username))
}

export async function resetCredential(
  pool: Pool,
  username: string,
  newPassword: string,
): Promise<CredentialResetMutation> {
  const passwordHash = await createPasswordHash(passwordSchema.parse(newPassword))
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const row = await findCredential(client, username, true)
    await client.query(
      `UPDATE users SET password_hash = $2, updated_at = now()
       WHERE id = $1`,
      [row.id, passwordHash],
    )
    const sessions = await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [row.id])
    await client.query('COMMIT')
    return {
      ...toStatus({
        ...row,
        credential_configured: true,
        active_sessions: '0',
      }),
      changed: true,
      sessionsRevoked: sessions.rowCount ?? 0,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
