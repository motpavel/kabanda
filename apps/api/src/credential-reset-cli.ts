import { passwordSchema, usernameSchema } from '@kabanda/contracts'
import dotenv from 'dotenv'
import { z } from 'zod'
import { assertAlphaOperatorContext } from './alpha-access.js'
import { inspectCredentialReset, resetCredential } from './credential-reset.js'
import { loadConfig } from './config.js'
import { createDatabase } from './database.js'

dotenv.config({ path: new URL('../../../.env', import.meta.url) })

const command = z.enum(['status', 'reset']).parse(process.env.CREDENTIAL_COMMAND)
const username = usernameSchema.parse(process.env.CREDENTIAL_USERNAME)
const apply = process.env.CREDENTIAL_APPLY === 'true'
const config = loadConfig()
if (config.ALPHA_ACCESS_MODE !== 'enforced' || !config.ALPHA_ACCESS_SECRET) {
  throw new Error('Closed-alpha access must be enforced for credential commands')
}

async function readPassword(): Promise<string> {
  let input = ''
  for await (const chunk of process.stdin) {
    input += String(chunk)
    if (input.length > 130) throw new Error('Credential password input is too long')
  }
  const password = input.endsWith('\r\n') ? input.slice(0, -2)
    : input.endsWith('\n') ? input.slice(0, -1)
      : input
  return passwordSchema.parse(password)
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
    process.stdout.write(`${JSON.stringify(await inspectCredentialReset(database, username))}\n`)
  } else if (!apply) {
    const status = await inspectCredentialReset(database, username)
    process.stdout.write(`${JSON.stringify({ ...status, dryRun: true, command })}\n`)
  } else {
    if (process.env.CREDENTIAL_CONFIRMATION !== `RESET:${username}`) {
      throw new Error('Credential operator confirmation mismatch')
    }
    const result = await resetCredential(database, username, await readPassword())
    process.stdout.write(`${JSON.stringify({ ...result, dryRun: false, command })}\n`)
  }
} finally {
  await database.end()
}
