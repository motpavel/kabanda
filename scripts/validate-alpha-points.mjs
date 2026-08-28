import { readFileSync } from 'node:fs'

const manifestPath = new URL('../docs/points/alpha-points.csv', import.meta.url)
const lines = readFileSync(manifestPath, 'utf8').trim().split('\n')
const expectedHeader = [
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

const header = lines.shift()?.split(',') ?? []
if (header.join('|') !== expectedHeader.join('|')) {
  throw new Error(`Unexpected alpha point header: ${header.join(',')}`)
}

if (lines.length < 20 || lines.length > 50) {
  throw new Error(`Alpha manifest must contain 20–50 points; received ${lines.length}`)
}

const ids = new Set()
const sourceIds = new Set()

for (const [index, line] of lines.entries()) {
  const rowNumber = index + 2
  const values = line.split(',')
  if (values.length !== expectedHeader.length) {
    throw new Error(`Row ${rowNumber} has ${values.length} columns instead of ${expectedHeader.length}`)
  }

  const row = Object.fromEntries(expectedHeader.map((field, fieldIndex) => [field, values[fieldIndex]]))
  const latitude = Number(row.latitude)
  const longitude = Number(row.longitude)

  if (ids.has(row.id)) throw new Error(`Duplicate point id at row ${rowNumber}: ${row.id}`)
  if (sourceIds.has(row.source_id)) {
    throw new Error(`Duplicate source_id at row ${rowNumber}: ${row.source_id}`)
  }
  ids.add(row.id)
  sourceIds.add(row.source_id)

  if (latitude < 56.7 || latitude > 57 || longitude < 53 || longitude > 53.4) {
    throw new Error(`Point outside the approved Izhevsk alpha bounds at row ${rowNumber}`)
  }
  if (!['source_checked', 'field_verified', 'rejected'].includes(row.verification_status)) {
    throw new Error(`Unknown verification status at row ${rowNumber}: ${row.verification_status}`)
  }
  if (!row.source_url.startsWith('https://www.openstreetmap.org/')) {
    throw new Error(`Unverifiable source URL at row ${rowNumber}`)
  }
}

console.log(`Validated ${lines.length} alpha point candidates with unique provenance.`)
