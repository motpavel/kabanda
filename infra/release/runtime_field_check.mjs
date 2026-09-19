// Run via stdin inside the EXISTING api container. Reads only, no changes.
import { createHash, createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
try {
  const origin = new URL(process.env.APP_ORIGIN)
  const target = new URL(process.env.DATABASE_URL)
  if (origin.origin !== 'https://kabanda.website.yandexcloud.net' || target.hostname !== '127.0.0.1' ||
      target.port !== '54329' || target.pathname !== '/kabanda') throw new Error('Wrong target')
  const ready = await fetch('http://127.0.0.1:3098/api/ready', {
    headers: { 'x-forwarded-host': origin.host, 'x-forwarded-proto': 'https' },
    signal: AbortSignal.timeout(5000), redirect: 'error',
  })
  await db.connect()
  await db.query('BEGIN READ ONLY')
  await db.query("SET LOCAL statement_timeout = '5s'")
  const migrations = await db.query('SELECT name FROM schema_migrations ORDER BY name')
  const active = await db.query("SELECT count(*)::int AS count FROM raids WHERE state IN ('active','paused','finalizing')")
  const sizes = await db.query(`SELECT relname,pg_total_relation_size(oid)::text AS bytes,reltuples::bigint::text AS estimated_rows
    FROM pg_class WHERE oid IN ('raid_route_samples'::regclass,'raid_point_credits'::regclass,'raid_point_visit_events'::regclass)`)
  await db.query('ROLLBACK')
  const der = createPublicKey(await readFile(process.env.RELAY_PRIVATE_KEY_FILE)).export({ type: 'spki', format: 'der' })
  console.log(JSON.stringify({ origin: origin.origin, apiBuild: process.env.API_BUILD_ID,
    ready: ready.ok, migrations: migrations.rows.map(row => row.name), inFlightRaids: active.rows[0].count,
    affectedTables: sizes.rows, publicKeySpkiSha256: createHash('sha256').update(der).digest('hex'),
    blobBucket: process.env.RELAY_BLOB_BUCKET,
    protectedRuntime: process.env.NODE_ENV === 'production' && process.env.ALPHA_ACCESS_MODE === 'enforced'
      && process.env.RELAY_ENABLED === 'true' && process.env.TRUST_PROXY_ADDRESS === 'loopback',
    checkedAt: new Date().toISOString(), note: 'Read-only evidence, not permission to deploy' }, null, 2))
} catch {
  console.error('STOP: read-only runtime inspection failed; details suppressed to protect credentials.')
  process.exitCode = 1
} finally { await db.end().catch(() => {}) }
