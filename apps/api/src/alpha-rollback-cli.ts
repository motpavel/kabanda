import dotenv from 'dotenv'
import { z } from 'zod'
import { assertAlphaOperatorContext } from './alpha-access.js'
import { applyAlphaRollback, inspectAlphaRollback } from './alpha-rollback.js'
import { loadConfig } from './config.js'
import { createDatabase } from './database.js'

dotenv.config({ path: new URL('../../../.env', import.meta.url) })

const config = loadConfig()
if (config.ALPHA_ACCESS_MODE !== 'enforced' || !config.ALPHA_ACCESS_SECRET) {
  throw new Error('Closed-alpha access must be enforced for rollback')
}
const kabandaId = z.uuid().parse(process.env.ALPHA_KABANDA_ID)
const ownerEmail = z.email().parse(process.env.ALPHA_OWNER_EMAIL?.trim().toLowerCase())
const expectedApiBuild = z.string().min(1).parse(process.env.ALPHA_EXPECTED_API_BUILD)
const apply = process.env.ALPHA_ROLLBACK_APPLY === 'true'
const database = createDatabase(config.DATABASE_URL)

try {
  await assertAlphaOperatorContext(database, {
    expectedDatabase: z.string().min(1).parse(process.env.ALPHA_EXPECTED_DATABASE),
    expectedApiBuild,
    actualApiBuild: config.API_BUILD_ID,
    expectedMigration: config.EXPECTED_MIGRATION,
  })
  const input = { kabandaId, ownerEmail, expectedApiBuild, secret: config.ALPHA_ACCESS_SECRET }
  if (!apply) {
    process.stdout.write(`${JSON.stringify(await inspectAlphaRollback(database, input))}\n`)
  } else {
    if (process.env.ALPHA_ROLLBACK_CONFIRMATION !== `ROLLBACK:${kabandaId}`) {
      throw new Error('Alpha rollback confirmation mismatch')
    }
    process.stdout.write(`${JSON.stringify(await applyAlphaRollback(database, input))}\n`)
  }
} finally {
  await database.end()
}
