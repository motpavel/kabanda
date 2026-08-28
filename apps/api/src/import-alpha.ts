import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import dotenv from 'dotenv'
import { loadConfig } from './config.js'
import { createDatabase } from './database.js'
import { DatabaseKabandaService, type ManifestPoint } from './kabandas.js'
import { validateAlphaPointManifestsWithArtifacts } from '../../../scripts/validate-alpha-points.mjs'

dotenv.config({ path: new URL('../../../.env', import.meta.url) })

function parseCsvLine(line: string): string[] {
  const values: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"' && line[index + 1] === '"' && quoted) {
      value += '"'
      index += 1
    } else if (character === '"') {
      quoted = !quoted
    } else if (character === ',' && !quoted) {
      values.push(value)
      value = ''
    } else {
      value += character
    }
  }
  values.push(value)
  return values
}

const kabandaId = process.env.ALPHA_KABANDA_ID
const ownerEmail = process.env.ALPHA_OWNER_EMAIL?.trim().toLowerCase()
if (!kabandaId || !ownerEmail) {
  throw new Error('ALPHA_KABANDA_ID and ALPHA_OWNER_EMAIL are required')
}

const csv = await readFile(new URL('../../../docs/points/alpha-points.csv', import.meta.url), 'utf8')
const fieldEvidenceCsv = await readFile(
  new URL('../../../docs/points/alpha-points-field-evidence.v1.csv', import.meta.url),
  'utf8',
)
await validateAlphaPointManifestsWithArtifacts({
  manifestContent: csv,
  fieldEvidenceContent: fieldEvidenceCsv,
  evidenceRoot: process.env.ALPHA_FIELD_EVIDENCE_ROOT,
})
const [headerLine, ...lines] = csv.trim().split(/\r?\n/)
const headers = parseCsvLine(headerLine ?? '')
const requiredHeaders = [
  'id',
  'name',
  'latitude',
  'longitude',
  'source',
  'source_id',
  'source_url',
  'license',
  'verification_status',
  'verified_at',
  'notes',
]
if (headers.join('|') !== requiredHeaders.join('|')) throw new Error('Unexpected alpha manifest header')

const rows = lines.map((line): ManifestPoint => {
  const values = parseCsvLine(line)
  const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
  if (!['source_checked', 'field_verified', 'rejected'].includes(row.verification_status!)) {
    throw new Error(`Unexpected verification status for ${row.id}`)
  }
  return {
    stableKey: row.id!,
    name: row.name!,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    source: row.source!,
    sourceId: row.source_id!,
    sourceUrl: row.source_url!,
    license: row.license!,
    verificationStatus: row.verification_status as ManifestPoint['verificationStatus'],
    verifiedAt: row.verified_at || null,
    notes: row.notes!,
  }
})

const database = createDatabase(loadConfig().DATABASE_URL)
try {
  const ownerResult = await database.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    ownerEmail,
  ])
  const ownerId = ownerResult.rows[0]?.id
  if (!ownerId) throw new Error('Alpha owner was not found')
  const checksum = createHash('sha256').update(csv).digest('hex')
  const result = await new DatabaseKabandaService(database).importManifest(
    ownerId,
    kabandaId,
    'izhevsk-alpha-v1',
    checksum,
    'Ижевск — alpha',
    rows,
  )
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  await database.end()
}
