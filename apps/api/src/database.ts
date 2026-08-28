import { Pool } from 'pg'

export function createDatabase(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  })
}

export async function assertDatabaseReady(pool: Pool): Promise<void> {
  await pool.query('SELECT 1, PostGIS_Version()')
}
