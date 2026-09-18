// stdin: docker exec -i <existing-api-container> node --input-type=module
// Only SELECTs inside READ ONLY, a readiness GET, and public-key derivation.
import { createHash, createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
try {
  const origin = new URL(process.env.APP_ORIGIN)
  const target = new URL(process.env.DATABASE_URL)
  const ready = await fetch('http://127.0.0.1:3098/api/ready', {
    headers: { 'x-forwarded-host': origin.host, 'x-forwarded-proto': 'https' },
    signal: AbortSignal.timeout(5000), redirect: 'error',
  })
  const readyBody = ready.ok ? await ready.json() : {}
  await db.connect()
  await db.query('BEGIN READ ONLY')
  await db.query("SET LOCAL statement_timeout = '5s'")
  const migrations = await db.query('SELECT name FROM schema_migrations ORDER BY name')
  const active = await db.query("SELECT count(*)::int AS count FROM raids WHERE state IN ('active','paused','finalizing')")
  await db.query('ROLLBACK')
  const der = createPublicKey(await readFile(process.env.RELAY_PRIVATE_KEY_FILE)).export({ type: 'spki', format: 'der' })
  console.log(JSON.stringify({
    origin: origin.origin, apiBuild: process.env.API_BUILD_ID,
    apiReady: ready.ok && readyBody.status === 'ready',
    migrations: migrations.rows.map(row => row.name), inFlightRaids: active.rows[0].count,
    publicKeySpkiSha256: createHash('sha256').update(der).digest('hex'),
    blobBucket: process.env.RELAY_BLOB_BUCKET,
    destinationDatabase: target.hostname === '127.0.0.1' && target.port === '54329' && target.pathname === '/kabanda',
    productionGuards: process.env.NODE_ENV === 'production' && process.env.ALPHA_ACCESS_MODE === 'enforced'
      && process.env.RELAY_ENABLED === 'true' && process.env.TRUST_PROXY_ADDRESS === 'loopback'
      && process.env.API_HOST === '127.0.0.1' && process.env.API_PORT === '3098' && process.env.RELAY_PORT === '3099',
  }))
} catch {
  console.error('Read-only runtime inspection failed; details suppressed to protect credentials.')
  process.exitCode = 1
} finally {
  await db.end().catch(() => {})
}
