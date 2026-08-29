import { Pool } from 'pg'

export function createDatabase(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  })
}

export async function assertDatabaseReady(pool: Pool, expectedMigration: string): Promise<void> {
  const result = await pool.query<{ current_migration: string | null; postgis_version: string }>(`
    SELECT
      PostGIS_Version() AS postgis_version,
      (SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1) AS current_migration
  `)
  const currentMigration = result.rows[0]?.current_migration
  if (currentMigration !== expectedMigration) {
    throw new Error(
      `Database migration mismatch: expected ${expectedMigration}, found ${currentMigration ?? 'none'}`,
    )
  }
}
