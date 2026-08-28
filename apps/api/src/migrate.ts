import { readdir, readFile } from 'node:fs/promises'
import dotenv from 'dotenv'
import { loadConfig } from './config.js'
import { createDatabase } from './database.js'

dotenv.config({ path: new URL('../../../.env', import.meta.url) })

const config = loadConfig()
const database = createDatabase(config.DATABASE_URL)
const migrationsDirectory = new URL('../../../infra/postgres/migrations/', import.meta.url)

await database.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`)

const migrationMax = process.env.MIGRATION_MAX
const files = (await readdir(migrationsDirectory))
  .filter((file) => file.endsWith('.sql') && (!migrationMax || file <= migrationMax))
  .sort()
for (const file of files) {
  const alreadyApplied = await database.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file])
  if (alreadyApplied.rowCount) continue

  const sql = await readFile(new URL(file, migrationsDirectory), 'utf8')
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    await client.query(sql)
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
    await client.query('COMMIT')
    process.stdout.write(`Applied ${file}\n`)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

await database.end()
