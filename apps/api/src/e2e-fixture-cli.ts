import {
  attachVerifiedPoint,
  inspectE2ERaid,
  prepareE2EIdentity,
  requireE2EDatabaseUrl,
  requireE2ERunId,
} from './e2e-fixture.js'

if (process.env.NODE_ENV !== 'test') throw new Error('E2E fixtures require NODE_ENV=test')

const [command, ...args] = process.argv.slice(2)
const databaseUrl = requireE2EDatabaseUrl()
requireE2ERunId()

let result: unknown
if (command === 'prepare') {
  result = await prepareE2EIdentity(databaseUrl)
} else if (command === 'attach-point') {
  const kabandaId = args[0]
  if (!kabandaId) throw new Error('attach-point requires kabandaId')
  result = await attachVerifiedPoint(kabandaId, databaseUrl)
} else if (command === 'inspect-raid') {
  const raidId = args[0]
  if (!raidId) throw new Error('inspect-raid requires raidId')
  const requiredRouteSequence = args[1] === undefined ? null : Number(args[1])
  result = await inspectE2ERaid(raidId, databaseUrl, undefined, requiredRouteSequence)
} else {
  throw new Error('Expected prepare, attach-point or inspect-raid')
}

process.stdout.write(`${JSON.stringify(result)}\n`)
