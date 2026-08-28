import { createHash } from 'node:crypto'
import { Pool } from 'pg'
import { DatabaseKabandaService, type ManifestPoint } from './kabandas.js'

export const E2E_DATABASE_NAME = 'kabanda_e2e'
export const E2E_DATABASE_MARKER = 'kabanda-e2e-disposable-v1'
export const E2E_POINT = {
  latitude: 56.86,
  longitude: 53.21,
} as const

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type E2EIdentity = {
  runId: string
  userId: string
  email: string
  displayName: string
  sessionToken: string
  cookieName: 'kabanda_session'
  point: typeof E2E_POINT
}

export type E2ERaidCounts = {
  routeSamples: number
  routeReceipts: number
  checkInAttempts: number
  pointCredits: number
  media: number
  readyMedia: number
  requiredRouteSequenceAccepted: boolean | null
}

export function requireE2ERunId(value = process.env.E2E_RUN_ID): string {
  if (!value || !uuidPattern.test(value)) {
    throw new Error('E2E_RUN_ID must be a UUID')
  }
  return value.toLowerCase()
}

export function requireE2EDatabaseUrl(value = process.env.E2E_DATABASE_URL): string {
  if (!value) throw new Error('E2E_DATABASE_URL is required')
  const parsed = new URL(value)
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('E2E_DATABASE_URL must use PostgreSQL')
  }
  if (parsed.pathname !== `/${E2E_DATABASE_NAME}`) {
    throw new Error(`E2E database must be exactly ${E2E_DATABASE_NAME}`)
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('E2E database host must be loopback')
  }
  if (decodeURIComponent(parsed.username) !== E2E_DATABASE_NAME) {
    throw new Error(`E2E database user must be exactly ${E2E_DATABASE_NAME}`)
  }
  if (!parsed.password) throw new Error('E2E database password must be non-empty')
  if (parsed.search || parsed.hash) throw new Error('E2E database URL options and fragments are forbidden')
  return parsed.toString()
}

export async function assertE2EDatabaseGuard(pool: Pool): Promise<void> {
  const result = await pool.query<{
    name: string
    username: string
    marker: string | null
    rolsuper: boolean
    rolcreatedb: boolean
    rolcreaterole: boolean
    rolreplication: boolean
    rolbypassrls: boolean
  }>(
    `SELECT current_database() AS name,
       current_user AS username,
       shobj_description(d.oid, 'pg_database') AS marker,
       r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls
     FROM pg_database d
     JOIN pg_roles r ON r.rolname = current_user
     WHERE d.datname = current_database()`,
  )
  const row = result.rows[0]
  if (
    row?.name !== E2E_DATABASE_NAME ||
    row.username !== E2E_DATABASE_NAME ||
    row.marker !== E2E_DATABASE_MARKER ||
    row.rolsuper ||
    row.rolcreatedb ||
    row.rolcreaterole ||
    row.rolreplication ||
    row.rolbypassrls
  ) {
    throw new Error('Refusing E2E fixture write: database identity, marker or role capability mismatch')
  }
}

export function requireE2ERunnerEnvironment(environment = process.env): {
  databaseUrl: string
  runId: string
} {
  if (environment.NODE_ENV !== 'test') throw new Error('E2E runner requires NODE_ENV=test')
  if (environment.KABANDA_E2E !== 'true') throw new Error('E2E runner requires KABANDA_E2E=true')
  return {
    databaseUrl: requireE2EDatabaseUrl(environment.E2E_DATABASE_URL),
    runId: requireE2ERunId(environment.E2E_RUN_ID),
  }
}

function identityFor(runId: string) {
  return {
    email: `kabanda-e2e+${runId}@example.test`,
    displayName: `E2E Кабан ${runId.slice(0, 8)}`,
    sessionToken: `kabanda-e2e-session-v1:${runId}`,
  }
}

export async function prepareE2EIdentity(
  databaseUrl = requireE2EDatabaseUrl(),
  runId = requireE2ERunId(),
): Promise<E2EIdentity> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  const identity = identityFor(runId)
  try {
    await assertE2EDatabaseGuard(pool)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (email, display_name)
         VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
         RETURNING id`,
        [identity.email, identity.displayName],
      )
      const userId = user.rows[0]!.id
      await client.query(
        `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
         VALUES ($1, $2, now() + interval '1 day')
         ON CONFLICT (token_hash) DO UPDATE
           SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at`,
        [createHash('sha256').update(identity.sessionToken).digest('hex'), userId],
      )
      await client.query('COMMIT')
      return {
        runId,
        userId,
        ...identity,
        cookieName: 'kabanda_session',
        point: E2E_POINT,
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

export async function attachVerifiedPoint(
  kabandaId: string,
  databaseUrl = requireE2EDatabaseUrl(),
  runId = requireE2ERunId(),
): Promise<{ collectionId: string; reportId: string }> {
  if (!uuidPattern.test(kabandaId)) throw new Error('kabandaId must be a UUID')
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  const identity = identityFor(runId)
  try {
    await assertE2EDatabaseGuard(pool)
    const owner = await pool.query<{ id: string }>(
      `SELECT users.id FROM users
       JOIN kabandas ON kabandas.owner_id = users.id
       WHERE users.email = $1 AND users.display_name = $2 AND kabandas.id = $3`,
      [identity.email, identity.displayName, kabandaId],
    )
    const ownerId = owner.rows[0]?.id
    if (!ownerId) throw new Error('Kabanda is not owned by this exact E2E run')
    const stableKey = `kabanda-e2e-${runId}`
    const point: ManifestPoint = {
      stableKey,
      name: 'Синтетическая точка E2E',
      ...E2E_POINT,
      source: 'synthetic-e2e',
      sourceId: stableKey,
      sourceUrl: 'https://example.test/kabanda-e2e-fixture',
      license: 'test-only',
      verificationStatus: 'field_verified',
      verifiedAt: '2026-08-28T00:00:00.000Z',
      notes: 'Synthetic disposable fixture; contains no real route or person data.',
    }
    const checksum = createHash('sha256').update(JSON.stringify(point)).digest('hex')
    const imported = await new DatabaseKabandaService(pool).importManifest(
      ownerId,
      kabandaId,
      `e2e-${runId}`,
      checksum,
      'Synthetic E2E points',
      [point],
    )
    return { collectionId: imported.collectionId, reportId: imported.reportId }
  } finally {
    await pool.end()
  }
}

export async function inspectE2ERaid(
  raidId: string,
  databaseUrl = requireE2EDatabaseUrl(),
  runId = requireE2ERunId(),
  requiredRouteSequence: number | null = null,
): Promise<E2ERaidCounts> {
  if (!uuidPattern.test(raidId)) throw new Error('raidId must be a UUID')
  if (requiredRouteSequence !== null && (!Number.isSafeInteger(requiredRouteSequence) || requiredRouteSequence < 1)) {
    throw new Error('requiredRouteSequence must be a positive safe integer')
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  const identity = identityFor(runId)
  try {
    await assertE2EDatabaseGuard(pool)
    const result = await pool.query<{
      route_samples: string
      route_receipts: string
      check_in_attempts: string
      point_credits: string
      media: string
      ready_media: string
      required_route_sequence_accepted: boolean | null
    }>(
      `SELECT
         (SELECT count(*) FROM raid_route_samples WHERE raid_id = r.id)::text AS route_samples,
         (SELECT count(*) FROM raid_route_batch_receipts WHERE raid_id = r.id)::text AS route_receipts,
         (SELECT count(*) FROM raid_checkin_attempts WHERE raid_id = r.id)::text AS check_in_attempts,
         (SELECT count(*) FROM raid_point_credits WHERE raid_id = r.id)::text AS point_credits,
         (SELECT count(*) FROM raid_media WHERE raid_id = r.id)::text AS media,
         (SELECT count(*) FROM raid_media WHERE raid_id = r.id AND state = 'ready')::text AS ready_media,
         CASE WHEN $4::bigint IS NULL THEN NULL ELSE EXISTS (
           SELECT 1 FROM raid_route_samples WHERE raid_id = r.id AND sequence = $4
         ) END AS required_route_sequence_accepted
       FROM raids r
       JOIN kabandas k ON k.id = r.kabanda_id
       JOIN users u ON u.id = k.owner_id
       WHERE r.id = $1 AND u.email = $2 AND u.display_name = $3`,
      [raidId, identity.email, identity.displayName, requiredRouteSequence],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Raid is not owned by this exact E2E run')
    return {
      routeSamples: Number(row.route_samples),
      routeReceipts: Number(row.route_receipts),
      checkInAttempts: Number(row.check_in_attempts),
      pointCredits: Number(row.point_credits),
      media: Number(row.media),
      readyMedia: Number(row.ready_media),
      requiredRouteSequenceAccepted: row.required_route_sequence_accepted,
    }
  } finally {
    await pool.end()
  }
}
