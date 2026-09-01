import dotenv from 'dotenv'
import { DatabaseAuthService } from './auth.js'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { assertDatabaseReady, createDatabase } from './database.js'
import { NominatimReverseGeocoder } from './geocoding.js'
import { SmtpMagicLinkMailer } from './mailer.js'
import { DatabaseKabandaService } from './kabandas.js'
import { DatabaseRaidService } from './raids.js'
import { DatabaseRaidTemplateService } from './raid-templates.js'

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
const kabandas = new DatabaseKabandaService(database, {
  alphaAccessMode: config.ALPHA_ACCESS_MODE,
  ...(config.ALPHA_ACCESS_SECRET ? { alphaAccessSecret: config.ALPHA_ACCESS_SECRET } : {}),
  sessionTtlDays: config.SESSION_TTL_DAYS,
})
const raids = new DatabaseRaidService(database, config.MEDIA_CAPABILITY_SECRET)
const raidTemplates = new DatabaseRaidTemplateService(database)
const geocoding = new NominatimReverseGeocoder({
  baseUrl: config.NOMINATIM_BASE_URL,
  appOrigin: config.APP_ORIGIN,
  userAgent: `KabandaClosedAlpha/${config.API_BUILD_ID} (${config.APP_ORIGIN})`,
})
const app = await buildApp({
  auth,
  kabandas,
  raids,
  raidTemplates,
  geocoding,
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
