import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const manifestPath = new URL('../docs/points/alpha-points.csv', import.meta.url)
const fieldEvidencePath = new URL('../docs/points/alpha-points-field-evidence.v1.csv', import.meta.url)

export const expectedManifestHeader = [
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

export const expectedFieldEvidenceHeader = [
  'schema_version',
  'point_id',
  'measured_latitude',
  'measured_longitude',
  'gps_accuracy_m',
  'measured_at',
  'safe_stop_outcome',
  'evidence_sha256',
  'evidence_ref',
]

const FIELD_EVIDENCE_SCHEMA_VERSION = '1'
const MAX_FIELD_GPS_ACCURACY_M = 50
const COORDINATE_TOLERANCE_DEGREES = 0.000001
const IZHEVSK_BOUNDS = { minLatitude: 56.7, maxLatitude: 57, minLongitude: 53, maxLongitude: 53.4 }

function parseCsv(content, expectedHeader, label) {
  const lines = content.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/)
  const header = lines.shift()?.split(',') ?? []
  if (header.join('|') !== expectedHeader.join('|')) {
    throw new Error(`Unexpected ${label} header: ${header.join(',')}`)
  }

  return lines.filter((line) => line.length > 0).map((line, index) => {
    const rowNumber = index + 2
    const values = line.split(',')
    if (values.length !== expectedHeader.length) {
      throw new Error(
        `${label} row ${rowNumber} has ${values.length} columns instead of ${expectedHeader.length}`,
      )
    }
    return {
      rowNumber,
      value: Object.fromEntries(expectedHeader.map((field, fieldIndex) => [field, values[fieldIndex]])),
    }
  })
}

function isInsideIzhevskBounds(latitude, longitude) {
  return (
    latitude >= IZHEVSK_BOUNDS.minLatitude &&
    latitude <= IZHEVSK_BOUNDS.maxLatitude &&
    longitude >= IZHEVSK_BOUNDS.minLongitude &&
    longitude <= IZHEVSK_BOUNDS.maxLongitude
  )
}

function isTimestampWithTimezone(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return false

  const [, year, month, day, hour, minute, second, fraction = '0'] = match
  const parts = [year, month, day, hour, minute, second].map(Number)
  const localTime = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5], Number(fraction.padEnd(3, '0')))
  const normalized = new Date(localTime)
  return (
    Number.isFinite(Date.parse(value)) &&
    normalized.getUTCFullYear() === parts[0] &&
    normalized.getUTCMonth() === parts[1] - 1 &&
    normalized.getUTCDate() === parts[2] &&
    normalized.getUTCHours() === parts[3] &&
    normalized.getUTCMinutes() === parts[4] &&
    normalized.getUTCSeconds() === parts[5]
  )
}

function isRestrictedEvidenceRef(value) {
  if (!/^restricted\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value)) return false
  const segments = value.split('/')
  return !value.includes('//') && !segments.includes('.') && !segments.includes('..')
}

export function validateAlphaPointManifests({ manifestContent, fieldEvidenceContent }) {
  const manifestRows = parseCsv(manifestContent, expectedManifestHeader, 'alpha point')
  const evidenceRows = parseCsv(fieldEvidenceContent, expectedFieldEvidenceHeader, 'field evidence')

  if (manifestRows.length < 20 || manifestRows.length > 50) {
    throw new Error(`Alpha manifest must contain 20–50 points; received ${manifestRows.length}`)
  }

  const ids = new Set()
  const sourceIds = new Set()
  const pointsById = new Map()

  for (const { rowNumber, value: row } of manifestRows) {
    const latitude = Number(row.latitude)
    const longitude = Number(row.longitude)

    if (ids.has(row.id)) throw new Error(`Duplicate point id at row ${rowNumber}: ${row.id}`)
    if (sourceIds.has(row.source_id)) {
      throw new Error(`Duplicate source_id at row ${rowNumber}: ${row.source_id}`)
    }
    ids.add(row.id)
    sourceIds.add(row.source_id)
    pointsById.set(row.id, { rowNumber, value: row })

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !isInsideIzhevskBounds(latitude, longitude)) {
      throw new Error(`Point outside the approved Izhevsk alpha bounds at row ${rowNumber}`)
    }
    if (!['source_checked', 'field_verified', 'rejected'].includes(row.verification_status)) {
      throw new Error(`Unknown verification status at row ${rowNumber}: ${row.verification_status}`)
    }
    if (!row.source_url.startsWith('https://www.openstreetmap.org/')) {
      throw new Error(`Unverifiable source URL at row ${rowNumber}`)
    }
  }

  const evidenceByPointId = new Map()
  for (const { rowNumber, value: evidence } of evidenceRows) {
    if (evidence.schema_version !== FIELD_EVIDENCE_SCHEMA_VERSION) {
      throw new Error(`Unsupported field evidence schema at row ${rowNumber}: ${evidence.schema_version}`)
    }
    if (!pointsById.has(evidence.point_id)) {
      throw new Error(`Field evidence row ${rowNumber} references unknown point: ${evidence.point_id}`)
    }
    if (evidenceByPointId.has(evidence.point_id)) {
      throw new Error(`Duplicate field evidence at row ${rowNumber}: ${evidence.point_id}`)
    }

    const measuredLatitude = Number(evidence.measured_latitude)
    const measuredLongitude = Number(evidence.measured_longitude)
    const gpsAccuracyM = Number(evidence.gps_accuracy_m)
    if (
      !Number.isFinite(measuredLatitude) ||
      !Number.isFinite(measuredLongitude) ||
      !isInsideIzhevskBounds(measuredLatitude, measuredLongitude)
    ) {
      throw new Error(`Invalid measured coordinates in field evidence row ${rowNumber}`)
    }
    if (!Number.isFinite(gpsAccuracyM) || gpsAccuracyM <= 0 || gpsAccuracyM > MAX_FIELD_GPS_ACCURACY_M) {
      throw new Error(`GPS accuracy must be within (0, ${MAX_FIELD_GPS_ACCURACY_M}] m at field evidence row ${rowNumber}`)
    }
    if (!isTimestampWithTimezone(evidence.measured_at)) {
      throw new Error(`Measured timestamp must be ISO 8601 with timezone at field evidence row ${rowNumber}`)
    }
    if (!['approved', 'relocate', 'rejected'].includes(evidence.safe_stop_outcome)) {
      throw new Error(`Unknown safe-stop outcome at field evidence row ${rowNumber}: ${evidence.safe_stop_outcome}`)
    }
    if (!/^[a-f0-9]{64}$/.test(evidence.evidence_sha256)) {
      throw new Error(`Evidence SHA-256 must be 64 lowercase hex characters at field evidence row ${rowNumber}`)
    }
    if (!isRestrictedEvidenceRef(evidence.evidence_ref)) {
      throw new Error(`Evidence ref must be an opaque restricted/ reference at field evidence row ${rowNumber}`)
    }

    evidenceByPointId.set(evidence.point_id, evidence)
  }

  for (const { rowNumber, value: point } of manifestRows) {
    if (point.verification_status !== 'field_verified') continue

    const evidence = evidenceByPointId.get(point.id)
    if (!evidence) {
      throw new Error(`field_verified point at row ${rowNumber} has no v1 field evidence: ${point.id}`)
    }
    if (evidence.safe_stop_outcome !== 'approved') {
      throw new Error(`field_verified point at row ${rowNumber} must have approved safe-stop outcome: ${point.id}`)
    }
    if (point.verified_at !== evidence.measured_at) {
      throw new Error(`field_verified point at row ${rowNumber} must use the evidence measured_at timestamp: ${point.id}`)
    }

    const latitudeDelta = Math.abs(Number(point.latitude) - Number(evidence.measured_latitude))
    const longitudeDelta = Math.abs(Number(point.longitude) - Number(evidence.measured_longitude))
    if (latitudeDelta > COORDINATE_TOLERANCE_DEGREES || longitudeDelta > COORDINATE_TOLERANCE_DEGREES) {
      throw new Error(`field_verified point at row ${rowNumber} must use measured safe-stop coordinates: ${point.id}`)
    }
  }

  return { pointCount: manifestRows.length, fieldEvidenceCount: evidenceRows.length }
}

function runCli() {
  const result = validateAlphaPointManifests({
    manifestContent: readFileSync(manifestPath, 'utf8'),
    fieldEvidenceContent: readFileSync(fieldEvidencePath, 'utf8'),
  })
  console.log(
    `Validated ${result.pointCount} alpha point candidates and ${result.fieldEvidenceCount} versioned field evidence records.`,
  )
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) runCli()
