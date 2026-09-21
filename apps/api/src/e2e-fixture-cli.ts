import {
  attachVerifiedPoint,
  ageE2EPointVisit,
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
} else if (command === 'attach-point' || command === 'attach-catalogue') {
  const kabandaId = args[0]
  if (!kabandaId) throw new Error('attach-point requires kabandaId')
  result = await attachVerifiedPoint(kabandaId, databaseUrl, undefined, command === 'attach-catalogue')
} else if (command === 'age-point-visit') {
  const raidId = args[0]
  if (!raidId) throw new Error('age-point-visit requires raidId')
  result = await ageE2EPointVisit(raidId, databaseUrl)
} else if (command === 'inspect-raid') {
  const raidId = args[0]
  if (!raidId) throw new Error('inspect-raid requires raidId')
  const requiredRouteSequence = args[1] === undefined ? null : Number(args[1])
  result = await inspectE2ERaid(raidId, databaseUrl, undefined, requiredRouteSequence)
} else {
  throw new Error('Expected prepare, attach-point, attach-catalogue, age-point-visit or inspect-raid')
}

process.stdout.write(`${JSON.stringify(result)}\n`)
