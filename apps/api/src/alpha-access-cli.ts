import dotenv from 'dotenv'
import { z } from 'zod'
import {
  assertAlphaOperatorContext,
  enrollAlphaAccess,
  inspectAlphaAccess,
  revokeAlphaAccess,
} from './alpha-access.js'
import { loadConfig } from './config.js'
import { createDatabase } from './database.js'

dotenv.config({ path: new URL('../../../.env', import.meta.url) })

const command = z.enum(['status', 'enroll', 'revoke']).parse(process.env.ALPHA_ACCESS_COMMAND)
const email = process.env.ALPHA_ACCESS_EMAIL
  ? z.email().parse(process.env.ALPHA_ACCESS_EMAIL.trim().toLowerCase())
  : undefined
const apply = process.env.ALPHA_ACCESS_APPLY === 'true'
const config = loadConfig()
if (config.ALPHA_ACCESS_MODE !== 'enforced' || !config.ALPHA_ACCESS_SECRET) {
  throw new Error('Closed-alpha access must be enforced for operator commands')
}

const database = createDatabase(config.DATABASE_URL)
try {
  await assertAlphaOperatorContext(database, {
    expectedDatabase: z.string().min(1).parse(process.env.ALPHA_EXPECTED_DATABASE),
    expectedApiBuild: z.string().min(1).parse(process.env.ALPHA_EXPECTED_API_BUILD),
    actualApiBuild: config.API_BUILD_ID,
    expectedMigration: config.EXPECTED_MIGRATION,
  })

  if (command === 'status') {
    process.stdout.write(`${JSON.stringify(await inspectAlphaAccess(database, config.ALPHA_ACCESS_SECRET, email))}\n`)
  } else {
    if (!email) throw new Error('ALPHA_ACCESS_EMAIL is required')
    const expectedConfirmation = `${command.toUpperCase()}:${email}`
    if (!apply) {
      const status = await inspectAlphaAccess(database, config.ALPHA_ACCESS_SECRET, email)
      process.stdout.write(`${JSON.stringify({ ...status, dryRun: true, command })}\n`)
    } else {
      if (process.env.ALPHA_ACCESS_CONFIRMATION !== expectedConfirmation) {
        throw new Error('Closed-alpha operator confirmation mismatch')
      }
      const result = command === 'enroll'
        ? await enrollAlphaAccess(database, email, config.ALPHA_ACCESS_SECRET)
        : await revokeAlphaAccess(database, email, config.ALPHA_ACCESS_SECRET)
      process.stdout.write(`${JSON.stringify({ ...result, dryRun: false, command })}\n`)
    }
  }
} finally {
  await database.end()
}
