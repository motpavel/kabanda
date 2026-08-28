import { createHmac } from 'node:crypto'
import { normalizeEmail } from '@kabanda/domain'
import type { Pool, PoolClient } from 'pg'
import { acquireAlphaIdentityLock, alphaEmailFingerprint } from './alpha-access.js'

export class AlphaRollbackError extends Error {
  constructor(
    readonly code:
      | 'ALPHA_ROLLBACK_TARGET_MISMATCH'
      | 'ALPHA_ROLLBACK_EXTERNAL_MEMBERSHIP'
      | 'ALPHA_ROLLBACK_GRANT_MISMATCH'
      | 'ALPHA_ROLLBACK_REPLAY_MISMATCH'
      | 'ALPHA_ROLLBACK_CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'AlphaRollbackError'
  }
}

type MemberRow = { user_id: string; email: string }

export type AlphaRollbackResult = {
  reportId: string | null
  kabandaId: string
  memberCount: number
  grantsRevoked: number
  invitesRevoked: number
  magicLinksInvalidated: number
  sessionsRevoked: number
  retainedResults: number
  changed: boolean
  alreadyApplied: boolean
  dryRun: boolean
}

type ReportRow = {
  id: string
  kabanda_id: string
  request_fingerprint: string
  member_count: number
  grants_revoked: number
  invites_revoked: number
  magic_links_invalidated: number
  sessions_revoked: number
  retained_results: number
}

function requestFingerprint(
  kabandaId: string,
  ownerEmail: string,
  expectedApiBuild: string,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(JSON.stringify({ kabandaId, ownerEmail: normalizeEmail(ownerEmail), expectedApiBuild }))
    .digest('hex')
}

function reportResult(row: ReportRow): AlphaRollbackResult {
  return {
    reportId: row.id,
    kabandaId: row.kabanda_id,
    memberCount: row.member_count,
    grantsRevoked: row.grants_revoked,
    invitesRevoked: row.invites_revoked,
    magicLinksInvalidated: row.magic_links_invalidated,
    sessionsRevoked: row.sessions_revoked,
    retainedResults: row.retained_results,
    changed: false,
    alreadyApplied: true,
    dryRun: false,
  }
}

async function targetMembers(
  client: Pool | PoolClient,
  kabandaId: string,
  ownerEmail: string,
): Promise<MemberRow[]> {
  const target = await client.query<{ owner_email: string }>(
    `SELECT u.email AS owner_email
     FROM kabandas k JOIN users u ON u.id = k.owner_id
     WHERE k.id = $1`,
    [kabandaId],
  )
  if (normalizeEmail(target.rows[0]?.owner_email ?? '') !== normalizeEmail(ownerEmail)) {
    throw new AlphaRollbackError('ALPHA_ROLLBACK_TARGET_MISMATCH', 'Alpha rollback target does not match')
  }
  const result = await client.query<MemberRow>(
    `SELECT m.user_id, u.email
     FROM kabanda_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.kabanda_id = $1 AND m.removed_at IS NULL
     ORDER BY m.user_id`,
    [kabandaId],
  )
  if (!result.rowCount || result.rowCount > 20) {
    throw new AlphaRollbackError('ALPHA_ROLLBACK_TARGET_MISMATCH', 'Alpha rollback member scope is invalid')
  }
  return result.rows
}

async function assertNoExternalMembership(
  client: Pool | PoolClient,
  kabandaId: string,
  memberIds: string[],
): Promise<void> {
  const result = await client.query(
    `SELECT 1
     FROM kabanda_memberships m
     JOIN kabandas k ON k.id = m.kabanda_id AND k.archived_at IS NULL
     WHERE m.user_id = ANY($2::uuid[])
       AND m.kabanda_id <> $1
       AND m.removed_at IS NULL
     LIMIT 1`,
    [kabandaId, memberIds],
  )
  if (result.rowCount) {
    throw new AlphaRollbackError(
      'ALPHA_ROLLBACK_EXTERNAL_MEMBERSHIP',
      'Alpha rollback member has access outside the exact target',
    )
  }
}

async function retainedResults(client: Pool | PoolClient, kabandaId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM raid_results WHERE kabanda_id = $1',
    [kabandaId],
  )
  return Number(result.rows[0]?.count ?? 0)
}

export async function inspectAlphaRollback(
  pool: Pool,
  input: { kabandaId: string; ownerEmail: string; expectedApiBuild: string; secret: string },
): Promise<AlphaRollbackResult> {
  const members = await targetMembers(pool, input.kabandaId, input.ownerEmail)
  await assertNoExternalMembership(pool, input.kabandaId, members.map(({ user_id }) => user_id))
  const fingerprints = members.map(({ email }) => alphaEmailFingerprint(email, input.secret))
  const active = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM alpha_access_grants
     WHERE email_fingerprint = ANY($1::bpchar[]) AND status = 'active'`,
    [fingerprints],
  )
  if (Number(active.rows[0]?.count ?? 0) !== members.length) {
    throw new AlphaRollbackError(
      'ALPHA_ROLLBACK_GRANT_MISMATCH',
      'Every active member must have an active closed-alpha grant',
    )
  }
  return {
    reportId: null,
    kabandaId: input.kabandaId,
    memberCount: members.length,
    grantsRevoked: members.length,
    invitesRevoked: 0,
    magicLinksInvalidated: 0,
    sessionsRevoked: 0,
    retainedResults: await retainedResults(pool, input.kabandaId),
    changed: false,
    alreadyApplied: false,
    dryRun: true,
  }
}

export async function applyAlphaRollback(
  pool: Pool,
  input: { kabandaId: string; ownerEmail: string; expectedApiBuild: string; secret: string },
  hooks: { afterGrantLocks?: () => Promise<void> } = {},
): Promise<AlphaRollbackResult> {
  const fingerprint = requestFingerprint(
    input.kabandaId,
    input.ownerEmail,
    input.expectedApiBuild,
    input.secret,
  )
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `kabanda-alpha-rollback-v1:${input.kabandaId}`,
    ])
    const prior = await client.query<ReportRow>(
      `SELECT id, kabanda_id, request_fingerprint, member_count, grants_revoked,
         invites_revoked, magic_links_invalidated, sessions_revoked, retained_results
       FROM alpha_rollback_reports WHERE kabanda_id = $1`,
      [input.kabandaId],
    )
    if (prior.rows[0]) {
      if (prior.rows[0].request_fingerprint !== fingerprint) {
        throw new AlphaRollbackError(
          'ALPHA_ROLLBACK_REPLAY_MISMATCH',
          'Alpha rollback replay does not match the applied request',
        )
      }
      await client.query('COMMIT')
      return reportResult(prior.rows[0])
    }

    const members = await targetMembers(client, input.kabandaId, input.ownerEmail)
    const memberIds = members.map(({ user_id }) => user_id)
    await assertNoExternalMembership(client, input.kabandaId, memberIds)
    const identities = members
      .map(({ email }) => ({ email: normalizeEmail(email), fingerprint: alphaEmailFingerprint(email, input.secret) }))
      .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint))
    for (const identity of identities) await acquireAlphaIdentityLock(client, identity.fingerprint)
    await assertNoExternalMembership(client, input.kabandaId, memberIds)

    const activeGrants = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM (
         SELECT id FROM alpha_access_grants
         WHERE email_fingerprint = ANY($1::bpchar[]) AND status = 'active'
         FOR UPDATE
       ) locked_grants`,
      [identities.map(({ fingerprint: value }) => value)],
    )
    if (Number(activeGrants.rows[0]?.count ?? 0) !== members.length) {
      throw new AlphaRollbackError(
        'ALPHA_ROLLBACK_GRANT_MISMATCH',
        'Every active member must have an active closed-alpha grant',
      )
    }
    await hooks.afterGrantLocks?.()

    const retained = await retainedResults(client, input.kabandaId)
    const invites = await client.query(
      `UPDATE kabanda_invites SET revoked_at = now()
       WHERE kabanda_id = $1 AND revoked_at IS NULL AND consumed_at IS NULL`,
      [input.kabandaId],
    )
    const grants = await client.query(
      `UPDATE alpha_access_grants
       SET status = 'revoked', revoked_at = now(), updated_at = now()
       WHERE email_fingerprint = ANY($1::bpchar[]) AND status = 'active'`,
      [identities.map(({ fingerprint: value }) => value)],
    )
    const links = await client.query(
      `UPDATE auth_magic_links SET consumed_at = now()
       WHERE email = ANY($1::citext[]) AND consumed_at IS NULL AND expires_at > now()`,
      [identities.map(({ email }) => email)],
    )
    await client.query(
      `UPDATE kabandas SET archived_at = COALESCE(archived_at, now()), updated_at = now()
       WHERE id = $1`,
      [input.kabandaId],
    )

    // Re-check the predicate immediately before global identity sessions are touched.
    await assertNoExternalMembership(client, input.kabandaId, memberIds)
    const sessions = await client.query(
      'DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])',
      [memberIds],
    )
    await assertNoExternalMembership(client, input.kabandaId, memberIds)

    const report = await client.query<ReportRow>(
      `INSERT INTO alpha_rollback_reports
         (kabanda_id, request_fingerprint, owner_user_id, member_count, grants_revoked,
          invites_revoked, magic_links_invalidated, sessions_revoked, retained_results)
       SELECT $1, $2, k.owner_id, $3, $4, $5, $6, $7, $8
       FROM kabandas k WHERE k.id = $1
       RETURNING id, kabanda_id, request_fingerprint, member_count, grants_revoked,
         invites_revoked, magic_links_invalidated, sessions_revoked, retained_results`,
      [
        input.kabandaId,
        fingerprint,
        members.length,
        grants.rowCount ?? 0,
        invites.rowCount ?? 0,
        links.rowCount ?? 0,
        sessions.rowCount ?? 0,
        retained,
      ],
    )
    await client.query('COMMIT')
    return { ...reportResult(report.rows[0]!), changed: true, alreadyApplied: false }
  } catch (error) {
    await client.query('ROLLBACK')
    if ((error as { code?: string }).code === '40001') {
      throw new AlphaRollbackError(
        'ALPHA_ROLLBACK_CONFLICT',
        'Alpha rollback conflicted with a concurrent membership change',
      )
    }
    throw error
  } finally {
    client.release()
  }
}
