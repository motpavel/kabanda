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
const mailer = new SmtpMagicLinkMailer({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE,
  requireTls: config.SMTP_REQUIRE_TLS,
  ...(config.SMTP_USER && config.SMTP_PASSWORD
    ? { user: config.SMTP_USER, password: config.SMTP_PASSWORD }
    : {}),
  from: config.SMTP_FROM,
})
const auth = new DatabaseAuthService(database, mailer, config)
const kabandas = new DatabaseKabandaService(database)
const raids = new DatabaseRaidService(database, config.MEDIA_CAPABILITY_SECRET)
const app = await buildApp({
  auth,
  kabandas,
  raids,
  config,
  readiness: () => assertDatabaseReady(database, config.EXPECTED_MIGRATION),
})

const shutdown = async () => {
  await app.close()
  await database.end()
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

await app.listen({ host: config.API_HOST, port: config.API_PORT })
