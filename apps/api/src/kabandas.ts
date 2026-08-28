import { createHash, randomBytes } from 'node:crypto'
import type { GeographicBounds } from '@kabanda/domain'
import { isBoundedIzhevskQuery } from '@kabanda/domain'
import type { Pool, PoolClient } from 'pg'

export class KabandaError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

export type KabandaSummary = {
  id: string
  name: string
  avatar: string
  role: 'owner' | 'member'
  memberCount: number
  pointsCollectionId: string | null
}

export type InvitePreview = {
  continuation: string
  kabanda: KabandaSummary
  inviterName: string
  expiresAt: string
  requiresAuth: boolean
  accepted: boolean
}

export type ManifestPoint = {
  stableKey: string
  name: string
  latitude: number
  longitude: number
  source: string
  sourceId: string
  sourceUrl: string
  license: string
  verificationStatus: 'source_checked' | 'field_verified' | 'rejected'
  verifiedAt: string | null
  notes: string
}

type SummaryRow = {
  id: string
  name: string
  avatar: string
  role: 'owner' | 'member'
  member_count: number
  points_collection_id: string | null
}

type MemberRow = {
  id: string
  display_name: string | null
  avatar_url: string | null
  role: 'owner' | 'member'
}

type PointRow = {
  id: string
  stable_key: string
  name: string
  latitude: number
  longitude: number
  verification_status: ManifestPoint['verificationStatus']
  visited_by_me: boolean
  visited_by_team: boolean
}

const summarySelect = `
  SELECT k.id, k.name, k.avatar, m.role,
    (SELECT count(*)::int FROM kabanda_memberships active
      WHERE active.kabanda_id = k.id AND active.removed_at IS NULL) AS member_count,
    (SELECT c.id FROM point_collections c
      WHERE c.kabanda_id = k.id AND c.archived_at IS NULL
      ORDER BY c.created_at, c.id LIMIT 1) AS points_collection_id
  FROM kabandas k
  JOIN kabanda_memberships m ON m.kabanda_id = k.id
  WHERE m.user_id = $1 AND m.removed_at IS NULL AND k.archived_at IS NULL`

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

function toSummary(row: SummaryRow): KabandaSummary {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    role: row.role,
    memberCount: Number(row.member_count),
    pointsCollectionId: row.points_collection_id,
  }
}

async function transaction<T>(pool: Pool, task: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await task(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export interface KabandaService {
  listKabandas(userId: string): Promise<KabandaSummary[]>
  createKabanda(userId: string, name: string, avatar: string, idempotencyKey: string): Promise<KabandaSummary>
  listMembers(userId: string, kabandaId: string): Promise<Array<Record<string, unknown>>>
  leaveKabanda(userId: string, kabandaId: string): Promise<void>
  removeMember(userId: string, kabandaId: string, memberId: string): Promise<void>
  createInvite(
    userId: string,
    kabandaId: string,
    expiresInHours: number,
  ): Promise<{ id: string; token: string; expiresAt: string }>
  revokeInvite(userId: string, kabandaId: string, inviteId: string): Promise<void>
  previewInvite(rawToken: string, requiresAuth: boolean): Promise<InvitePreview>
  previewContinuation(rawContinuation: string, requiresAuth: boolean, userId?: string): Promise<InvitePreview>
  acceptInvite(
    userId: string,
    continuation: string,
    idempotencyKey: string,
  ): Promise<KabandaSummary>
  listPoints(
    userId: string,
    collectionId: string,
    bounds: GeographicBounds,
    limit: number,
  ): Promise<{ points: Array<Record<string, unknown>>; nextCursor: null }>
}

export class DatabaseKabandaService implements KabandaService {
  constructor(private readonly pool: Pool) {}

  async listKabandas(userId: string): Promise<KabandaSummary[]> {
    const result = await this.pool.query<SummaryRow>(`${summarySelect} ORDER BY k.created_at, k.id`, [
      userId,
    ])
    return result.rows.map(toSummary)
  }

  async createKabanda(
    userId: string,
    name: string,
    avatar: string,
    idempotencyKey: string,
  ): Promise<KabandaSummary> {
    return transaction(this.pool, async (client) => {
      const result = await client.query<{ id: string; name: string; avatar: string }>(
        `INSERT INTO kabandas (name, avatar, owner_id, create_idempotency_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (owner_id, create_idempotency_key)
         DO UPDATE SET create_idempotency_key = EXCLUDED.create_idempotency_key
         RETURNING id, name, avatar`,
        [name, avatar, userId, idempotencyKey],
      )
      const kabanda = result.rows[0]
      if (!kabanda) throw new Error('Kabanda create did not return a row')
      if (kabanda.name !== name || kabanda.avatar !== avatar) {
        throw new KabandaError('IDEMPOTENCY_CONFLICT', 409, 'Ключ уже использован для другой команды')
      }
      await client.query(
        `INSERT INTO kabanda_memberships (kabanda_id, user_id, role)
         VALUES ($1, $2, 'owner')
         ON CONFLICT (kabanda_id, user_id) DO NOTHING`,
        [kabanda.id, userId],
      )
      return this.getSummary(client, userId, kabanda.id)
    })
  }

  async listMembers(userId: string, kabandaId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query<MemberRow>(
      `SELECT u.id, coalesce(u.display_name, split_part(u.email::text, '@', 1)) AS display_name,
         u.avatar_url, target.role
       FROM kabanda_memberships viewer
       JOIN kabandas k ON k.id = viewer.kabanda_id AND k.archived_at IS NULL
       JOIN kabanda_memberships target
         ON target.kabanda_id = viewer.kabanda_id AND target.removed_at IS NULL
       JOIN users u ON u.id = target.user_id
       WHERE viewer.kabanda_id = $1 AND viewer.user_id = $2 AND viewer.removed_at IS NULL
       ORDER BY target.role = 'owner' DESC, target.joined_at, target.id`,
      [kabandaId, userId],
    )
    if (result.rows.length === 0) throw this.notFound()
    return result.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      role: row.role,
      avatarUrl: row.avatar_url,
    }))
  }

  async leaveKabanda(userId: string, kabandaId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE kabanda_memberships member
       SET removed_at = now()
       FROM kabandas k
       WHERE member.kabanda_id = $1 AND member.user_id = $2
         AND member.kabanda_id = k.id AND k.archived_at IS NULL
         AND member.removed_at IS NULL AND member.role = 'member'`,
      [kabandaId, userId],
    )
    if (result.rowCount !== 1) throw this.notFound()
  }

  async removeMember(userId: string, kabandaId: string, memberId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE kabanda_memberships target
       SET removed_at = now()
       FROM kabanda_memberships owner, kabandas k
       WHERE target.kabanda_id = $1 AND target.user_id = $2
         AND target.role = 'member' AND target.removed_at IS NULL
         AND owner.kabanda_id = target.kabanda_id AND owner.user_id = $3
         AND owner.role = 'owner' AND owner.removed_at IS NULL
         AND k.id = target.kabanda_id AND k.archived_at IS NULL`,
      [kabandaId, memberId, userId],
    )
    if (result.rowCount !== 1) throw this.notFound()
  }

  async createInvite(
    userId: string,
    kabandaId: string,
    expiresInHours: number,
  ): Promise<{ id: string; token: string; expiresAt: string }> {
    return transaction(this.pool, async (client) => {
      await this.requireOwner(client, userId, kabandaId)
      await client.query('SELECT id FROM kabandas WHERE id = $1 FOR UPDATE', [kabandaId])
      await client.query(
        `UPDATE kabanda_invites SET revoked_at = now()
         WHERE kabanda_id = $1 AND created_by = $2
           AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > now()`,
        [kabandaId, userId],
      )
      const rawToken = randomBytes(32).toString('base64url')
      const result = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO kabanda_invites (kabanda_id, created_by, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + ($4 * interval '1 hour'))
         RETURNING id, expires_at`,
        [kabandaId, userId, hashToken(rawToken), expiresInHours],
      )
      const invite = result.rows[0]
      if (!invite) throw new Error('Invite create did not return a row')
      return { id: invite.id, token: rawToken, expiresAt: invite.expires_at.toISOString() }
    })
  }

  async revokeInvite(userId: string, kabandaId: string, inviteId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE kabanda_invites invite SET revoked_at = now()
       FROM kabanda_memberships owner
       WHERE invite.id = $1 AND invite.kabanda_id = $2
         AND owner.kabanda_id = invite.kabanda_id AND owner.user_id = $3
         AND owner.role = 'owner' AND owner.removed_at IS NULL
         AND invite.revoked_at IS NULL AND invite.consumed_at IS NULL`,
      [inviteId, kabandaId, userId],
    )
    if (result.rowCount !== 1) throw this.notFound()
  }

  async previewInvite(rawToken: string, requiresAuth: boolean): Promise<InvitePreview> {
    return transaction(this.pool, async (client) => {
      const inviteResult = await client.query<{
        id: string
        kabanda_id: string
        expires_at: Date
        inviter_name: string
      }>(
        `SELECT i.id, i.kabanda_id, i.expires_at,
           coalesce(u.display_name, split_part(u.email::text, '@', 1)) AS inviter_name
         FROM kabanda_invites i
         JOIN kabandas k ON k.id = i.kabanda_id AND k.archived_at IS NULL
         JOIN users u ON u.id = i.created_by
         WHERE i.token_hash = $1 AND i.revoked_at IS NULL
           AND i.consumed_at IS NULL AND i.expires_at > now()
         FOR SHARE OF i`,
        [hashToken(rawToken)],
      )
      const invite = inviteResult.rows[0]
      if (!invite) throw this.invalidInvite()

      const rawContinuation = randomBytes(32).toString('base64url')
      await client.query(
        `INSERT INTO invite_continuations (invite_id, token_hash, expires_at)
         VALUES ($1, $2, LEAST($3::timestamptz, now() + interval '30 minutes'))`,
        [invite.id, hashToken(rawContinuation), invite.expires_at],
      )
      const summary = await this.getPublicSummary(client, invite.kabanda_id)
      return {
        continuation: rawContinuation,
        kabanda: summary,
        inviterName: invite.inviter_name,
        expiresAt: invite.expires_at.toISOString(),
        requiresAuth,
        accepted: false,
      }
    })
  }

  async previewContinuation(
    rawContinuation: string,
    requiresAuth: boolean,
    userId?: string,
  ): Promise<InvitePreview> {
    return transaction(this.pool, async (client) => {
      const result = await client.query<{
        kabanda_id: string
        expires_at: Date
        inviter_name: string
      }>(
        `SELECT i.kabanda_id, LEAST(c.expires_at, i.expires_at) AS expires_at,
           coalesce(u.display_name, split_part(u.email::text, '@', 1)) AS inviter_name
         FROM invite_continuations c
         JOIN kabanda_invites i ON i.id = c.invite_id
         JOIN kabandas k ON k.id = i.kabanda_id AND k.archived_at IS NULL
         JOIN users u ON u.id = i.created_by
         WHERE c.token_hash = $1 AND c.consumed_at IS NULL AND c.expires_at > now()
           AND i.revoked_at IS NULL AND i.consumed_at IS NULL AND i.expires_at > now()`,
        [hashToken(rawContinuation)],
      )
      const invite = result.rows[0]
      if (!invite && userId) {
        const acceptedResult = await client.query<{
          kabanda_id: string
          expires_at: Date
          inviter_name: string
        }>(
          `SELECT i.kabanda_id, i.expires_at,
             coalesce(inviter.display_name, split_part(inviter.email::text, '@', 1)) AS inviter_name
           FROM invite_continuations c
           JOIN kabanda_invites i ON i.id = c.invite_id
           JOIN invite_acceptances a ON a.continuation_id = c.id AND a.user_id = $2
           JOIN kabanda_memberships m ON m.id = a.membership_id AND m.removed_at IS NULL
           JOIN kabandas k ON k.id = m.kabanda_id AND k.archived_at IS NULL
           JOIN users inviter ON inviter.id = i.created_by
           WHERE c.token_hash = $1`,
          [hashToken(rawContinuation), userId],
        )
        const accepted = acceptedResult.rows[0]
        if (accepted) {
          return {
            continuation: rawContinuation,
            kabanda: await this.getPublicSummary(client, accepted.kabanda_id),
            inviterName: accepted.inviter_name,
            expiresAt: accepted.expires_at.toISOString(),
            requiresAuth: false,
            accepted: true,
          }
        }
      }
      if (!invite) throw this.invalidInvite()
      return {
        continuation: rawContinuation,
        kabanda: await this.getPublicSummary(client, invite.kabanda_id),
        inviterName: invite.inviter_name,
        expiresAt: invite.expires_at.toISOString(),
        requiresAuth,
        accepted: false,
      }
    })
  }

  async acceptInvite(
    userId: string,
    continuation: string,
    idempotencyKey: string,
  ): Promise<KabandaSummary> {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${userId}:${idempotencyKey}`,
      ])
      const replay = await client.query<{ continuation_id: string; kabanda_id: string }>(
        `SELECT a.continuation_id, m.kabanda_id
         FROM invite_acceptances a
         JOIN kabanda_memberships m ON m.id = a.membership_id
         WHERE a.user_id = $1 AND a.idempotency_key = $2`,
        [userId, idempotencyKey],
      )
      if (replay.rows[0]) {
        const continuationResult = await client.query<{ id: string }>(
          'SELECT id FROM invite_continuations WHERE token_hash = $1',
          [hashToken(continuation)],
        )
        if (continuationResult.rows[0]?.id !== replay.rows[0].continuation_id) {
          throw new KabandaError('IDEMPOTENCY_CONFLICT', 409, 'Ключ уже использован')
        }
        return this.getSummary(client, userId, replay.rows[0].kabanda_id)
      }

      const continuationResult = await client.query<{
        continuation_id: string
        invite_id: string
        kabanda_id: string
      }>(
        `SELECT c.id AS continuation_id, i.id AS invite_id, i.kabanda_id
         FROM invite_continuations c
         JOIN kabanda_invites i ON i.id = c.invite_id
         JOIN kabandas k ON k.id = i.kabanda_id
         WHERE c.token_hash = $1 AND c.consumed_at IS NULL AND c.expires_at > now()
           AND i.revoked_at IS NULL AND i.consumed_at IS NULL AND i.expires_at > now()
           AND k.archived_at IS NULL
         FOR UPDATE OF c, i`,
        [hashToken(continuation)],
      )
      const pending = continuationResult.rows[0]
      if (!pending) throw this.invalidInvite()

      const membershipResult = await client.query<{ id: string }>(
        `INSERT INTO kabanda_memberships (kabanda_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (kabanda_id, user_id) DO UPDATE
           SET role = CASE
             WHEN kabanda_memberships.role = 'owner' THEN 'owner'::kabanda_membership_role
             ELSE 'member'::kabanda_membership_role END,
             removed_at = NULL, joined_at = now()
         RETURNING id`,
        [pending.kabanda_id, userId],
      )
      const membership = membershipResult.rows[0]
      if (!membership) throw new Error('Invite acceptance did not return membership')

      await client.query('UPDATE invite_continuations SET consumed_at = now() WHERE id = $1', [
        pending.continuation_id,
      ])
      await client.query('UPDATE kabanda_invites SET consumed_at = now() WHERE id = $1', [
        pending.invite_id,
      ])
      await client.query(
        `INSERT INTO invite_acceptances
          (invite_id, continuation_id, user_id, membership_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [pending.invite_id, pending.continuation_id, userId, membership.id, idempotencyKey],
      )
      return this.getSummary(client, userId, pending.kabanda_id)
    })
  }

  async listPoints(
    userId: string,
    collectionId: string,
    bounds: GeographicBounds,
    limit: number,
  ): Promise<{ points: Array<Record<string, unknown>>; nextCursor: null }> {
    if (!isBoundedIzhevskQuery(bounds)) {
      throw new KabandaError('BBOX_INVALID', 400, 'Область карты слишком большая')
    }
    const result = await this.pool.query<PointRow>(
      `SELECT p.id, p.stable_key, p.name,
         ST_Y(p.location)::float8 AS latitude, ST_X(p.location)::float8 AS longitude,
         p.verification_status,
         EXISTS (SELECT 1 FROM point_visits mine
           WHERE mine.kabanda_id = c.kabanda_id AND mine.point_id = p.id AND mine.user_id = $1)
           AS visited_by_me,
         EXISTS (SELECT 1 FROM point_visits team
           WHERE team.kabanda_id = c.kabanda_id AND team.point_id = p.id) AS visited_by_team
       FROM point_collections c
       JOIN kabanda_memberships member
         ON member.kabanda_id = c.kabanda_id AND member.user_id = $1 AND member.removed_at IS NULL
       JOIN kabandas k ON k.id = c.kabanda_id AND k.archived_at IS NULL
       JOIN collection_points cp
         ON cp.collection_id = c.id AND cp.archived_at IS NULL
       JOIN points p ON p.id = cp.point_id AND p.archived_at IS NULL
       WHERE c.id = $2 AND c.archived_at IS NULL
         AND ST_Covers(ST_MakeEnvelope($3, $4, $5, $6, 4326), p.location)
       ORDER BY cp.position, p.id LIMIT $7`,
      [
        userId,
        collectionId,
        bounds.minLon,
        bounds.minLat,
        bounds.maxLon,
        bounds.maxLat,
        limit,
      ],
    )
    if (result.rows.length === 0) {
      const visible = await this.pool.query(
        `SELECT 1 FROM point_collections c
         JOIN kabanda_memberships m ON m.kabanda_id = c.kabanda_id
         JOIN kabandas k ON k.id = c.kabanda_id
         WHERE c.id = $1 AND m.user_id = $2 AND m.removed_at IS NULL
           AND c.archived_at IS NULL AND k.archived_at IS NULL`,
        [collectionId, userId],
      )
      if (!visible.rowCount) throw this.notFound()
    }
    return {
      points: result.rows.map((row) => ({
        id: row.id,
        stableId: row.stable_key,
        name: row.name,
        latitude: row.latitude,
        longitude: row.longitude,
        verificationStatus: row.verification_status,
        visitedByMe: row.visited_by_me,
        visitedByTeam: row.visited_by_team,
      })),
      nextCursor: null,
    }
  }

  async importManifest(
    userId: string,
    kabandaId: string,
    manifestKey: string,
    checksum: string,
    collectionName: string,
    rows: ManifestPoint[],
  ): Promise<{ reportId: string; collectionId: string; rowCount: number; replayed: boolean }> {
    if (rows.length < 1 || rows.length > 50 || new Set(rows.map((row) => row.stableKey)).size !== rows.length) {
      throw new KabandaError('IMPORT_INVALID', 400, 'Манифест точек недействителен')
    }
    for (const row of rows) {
      if (
        !isBoundedIzhevskQuery({
          minLat: row.latitude - 0.00001,
          minLon: row.longitude - 0.00001,
          maxLat: row.latitude + 0.00001,
          maxLon: row.longitude + 0.00001,
        })
      ) {
        throw new KabandaError('IMPORT_INVALID', 400, 'Точка вне границ Ижевска')
      }
    }

    return transaction(this.pool, async (client) => {
      await this.requireOwner(client, userId, kabandaId)
      await client.query(
        `INSERT INTO point_import_reports (kabanda_id, manifest_key, checksum)
         VALUES ($1, $2, $3) ON CONFLICT (kabanda_id, manifest_key) DO NOTHING`,
        [kabandaId, manifestKey, checksum],
      )
      const reportResult = await client.query<{
        id: string
        checksum: string
        status: 'pending' | 'completed'
        collection_id: string | null
        row_count: number
      }>(
        `SELECT id, checksum, status, collection_id, row_count
         FROM point_import_reports WHERE kabanda_id = $1 AND manifest_key = $2 FOR UPDATE`,
        [kabandaId, manifestKey],
      )
      const report = reportResult.rows[0]
      if (!report) throw new Error('Import report was not created')
      if (report.checksum !== checksum) {
        throw new KabandaError('IMPORT_CONFLICT', 409, 'Ключ манифеста уже использован')
      }
      if (report.status === 'completed' && report.collection_id) {
        return {
          reportId: report.id,
          collectionId: report.collection_id,
          rowCount: Number(report.row_count),
          replayed: true,
        }
      }

      const collectionResult = await client.query<{ id: string }>(
        `INSERT INTO point_collections (kabanda_id, name, stable_key)
         VALUES ($1, $2, 'alpha-manifest')
         ON CONFLICT (kabanda_id, stable_key) WHERE stable_key IS NOT NULL
         DO UPDATE SET name = EXCLUDED.name, archived_at = NULL, updated_at = now()
         RETURNING id`,
        [kabandaId, collectionName],
      )
      const collectionId = collectionResult.rows[0]?.id
      if (!collectionId) throw new Error('Import collection was not returned')
      await client.query('DELETE FROM collection_points WHERE collection_id = $1', [collectionId])

      for (const [position, row] of rows.entries()) {
        const pointResult = await client.query<{ id: string }>(
          `INSERT INTO points
            (kabanda_id, stable_key, name, location, source, source_id, source_url, license,
             verification_status, verified_at, notes)
           VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (kabanda_id, stable_key) DO UPDATE SET
             name = EXCLUDED.name, location = EXCLUDED.location, source = EXCLUDED.source,
             source_id = EXCLUDED.source_id, source_url = EXCLUDED.source_url,
             license = EXCLUDED.license, verification_status = EXCLUDED.verification_status,
             verified_at = EXCLUDED.verified_at, notes = EXCLUDED.notes,
             archived_at = NULL, updated_at = now()
           RETURNING id`,
          [
            kabandaId,
            row.stableKey,
            row.name,
            row.longitude,
            row.latitude,
            row.source,
            row.sourceId,
            row.sourceUrl,
            row.license,
            row.verificationStatus,
            row.verifiedAt,
            row.notes,
          ],
        )
        await client.query(
          `INSERT INTO collection_points (collection_id, point_id, position) VALUES ($1, $2, $3)`,
          [collectionId, pointResult.rows[0]?.id, position],
        )
      }
      await client.query(
        `UPDATE point_import_reports SET status = 'completed', collection_id = $2,
           row_count = $3, completed_at = now() WHERE id = $1`,
        [report.id, collectionId, rows.length],
      )
      return {
        reportId: report.id,
        collectionId,
        rowCount: rows.length,
        replayed: false,
      }
    })
  }

  async recordVisit(
    userId: string,
    kabandaId: string,
    pointId: string,
    idempotencyKey: string,
  ): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO point_visits
        (kabanda_id, point_id, user_id, idempotency_key, point_name_snapshot, point_location_snapshot)
       SELECT c.kabanda_id, p.id, member.user_id, $4, p.name, p.location
       FROM points p
       JOIN collection_points cp ON cp.point_id = p.id AND cp.archived_at IS NULL
       JOIN point_collections c ON c.id = cp.collection_id AND c.archived_at IS NULL
       JOIN kabanda_memberships member ON member.kabanda_id = c.kabanda_id
       WHERE c.kabanda_id = $1 AND p.id = $2 AND member.user_id = $3
         AND member.removed_at IS NULL AND p.archived_at IS NULL
       ON CONFLICT (user_id, idempotency_key) DO UPDATE
         SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING id`,
      [kabandaId, pointId, userId, idempotencyKey],
    )
    const id = result.rows[0]?.id
    if (!id) throw this.notFound()
    return id
  }

  async updatePoint(
    userId: string,
    kabandaId: string,
    pointId: string,
    name: string,
    archived: boolean,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE points p SET name = $4, archived_at = CASE WHEN $5 THEN now() ELSE NULL END,
         updated_at = now()
       FROM collection_points cp, point_collections c, kabanda_memberships owner
       WHERE p.id = $1 AND cp.point_id = p.id AND c.id = cp.collection_id
         AND c.kabanda_id = $2 AND owner.kabanda_id = c.kabanda_id
         AND owner.user_id = $3 AND owner.role = 'owner' AND owner.removed_at IS NULL`,
      [pointId, kabandaId, userId, name, archived],
    )
    if (!result.rowCount) throw this.notFound()
  }

  private async getSummary(
    client: PoolClient,
    userId: string,
    kabandaId: string,
  ): Promise<KabandaSummary> {
    const result = await client.query<SummaryRow>(`${summarySelect} AND k.id = $2`, [
      userId,
      kabandaId,
    ])
    if (!result.rows[0]) throw this.notFound()
    return toSummary(result.rows[0])
  }

  private async getPublicSummary(client: PoolClient, kabandaId: string): Promise<KabandaSummary> {
    const result = await client.query<SummaryRow>(
      `SELECT k.id, k.name, k.avatar, 'member'::kabanda_membership_role AS role,
         (SELECT count(*)::int FROM kabanda_memberships m
           WHERE m.kabanda_id = k.id AND m.removed_at IS NULL) AS member_count,
         (SELECT c.id FROM point_collections c
           WHERE c.kabanda_id = k.id AND c.archived_at IS NULL
           ORDER BY c.created_at, c.id LIMIT 1) AS points_collection_id
       FROM kabandas k WHERE k.id = $1 AND k.archived_at IS NULL`,
      [kabandaId],
    )
    if (!result.rows[0]) throw this.invalidInvite()
    return toSummary(result.rows[0])
  }

  private async requireOwner(client: PoolClient, userId: string, kabandaId: string): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM kabanda_memberships owner
       JOIN kabandas k ON k.id = owner.kabanda_id
       WHERE owner.kabanda_id = $1 AND owner.user_id = $2 AND owner.role = 'owner'
         AND owner.removed_at IS NULL AND k.archived_at IS NULL`,
      [kabandaId, userId],
    )
    if (!result.rowCount) throw this.notFound()
  }

  private invalidInvite(): KabandaError {
    return new KabandaError('INVITE_INVALID', 400, 'Приглашение недействительно')
  }

  private notFound(): KabandaError {
    return new KabandaError('NOT_FOUND', 404, 'Ресурс не найден')
  }
}
