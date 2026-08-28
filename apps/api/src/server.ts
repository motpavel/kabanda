import dotenv from 'dotenv'
import { DatabaseAuthService } from './auth.js'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { assertDatabaseReady, createDatabase } from './database.js'
import { SmtpMagicLinkMailer } from './mailer.js'
import { DatabaseKabandaService } from './kabandas.js'
import { DatabaseRaidService } from './raids.js'

dotenv.config({ path: new URL('../../../.env', import.meta.url) })

const config = loadConfig()
const database = createDatabase(config.DATABASE_URL)
const mailer = new SmtpMagicLinkMailer(config.SMTP_HOST, config.SMTP_PORT, config.SMTP_FROM)
const auth = new DatabaseAuthService(database, mailer, config)
const kabandas = new DatabaseKabandaService(database)
const raids = new DatabaseRaidService(database)
const app = await buildApp({
  auth,
  kabandas,
  raids,
  config,
  readiness: () => assertDatabaseReady(database),
})

const shutdown = async () => {
  await app.close()
  await database.end()
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

await app.listen({ host: config.API_HOST, port: config.API_PORT })
