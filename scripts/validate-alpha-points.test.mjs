import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  expectedFieldEvidenceHeader,
  validateAlphaPointManifests,
} from './validate-alpha-points.mjs'

const manifestContent = readFileSync(new URL('../docs/points/alpha-points.csv', import.meta.url), 'utf8')
const emptyEvidenceContent = `${expectedFieldEvidenceHeader.join(',')}\n`
const measuredAt = '2026-08-28T08:30:00+04:00'
const evidenceSha256 = 'a'.repeat(64)

function fieldVerifiedFixture() {
  const lines = manifestContent.trimEnd().split(/\r?\n/)
  const header = lines[0].split(',')
  const firstRow = lines[1].split(',')
  const field = Object.fromEntries(header.map((name, index) => [name, index]))
  firstRow[field.verification_status] = 'field_verified'
  firstRow[field.verified_at] = measuredAt
  lines[1] = firstRow.join(',')

  return {
    manifest: `${lines.join('\n')}\n`,
    pointId: firstRow[field.id],
    latitude: firstRow[field.latitude],
    longitude: firstRow[field.longitude],
  }
}

function evidenceContent(overrides = {}) {
  const fixture = fieldVerifiedFixture()
  const row = {
    schema_version: '1',
    point_id: fixture.pointId,
    measured_latitude: fixture.latitude,
    measured_longitude: fixture.longitude,
    gps_accuracy_m: '12.5',
    measured_at: measuredAt,
    safe_stop_outcome: 'approved',
    evidence_sha256: evidenceSha256,
    evidence_ref: `restricted/alpha-points/${fixture.pointId}/${evidenceSha256}.json`,
    ...overrides,
  }
  return `${expectedFieldEvidenceHeader.join(',')}\n${expectedFieldEvidenceHeader.map((field) => row[field]).join(',')}\n`
}

test('keeps the current source_checked preview manifest importable without field evidence', () => {
  assert.deepEqual(
    validateAlphaPointManifests({ manifestContent, fieldEvidenceContent: emptyEvidenceContent }),
    { pointCount: 27, fieldEvidenceCount: 0 },
  )
})

test('accepts field_verified only with complete matching v1 evidence', () => {
  const fixture = fieldVerifiedFixture()
  assert.deepEqual(
    validateAlphaPointManifests({
      manifestContent: fixture.manifest,
      fieldEvidenceContent: evidenceContent(),
    }),
    { pointCount: 27, fieldEvidenceCount: 1 },
  )
})

test('fails closed when field_verified has no evidence', () => {
  const fixture = fieldVerifiedFixture()
  assert.throws(
    () => validateAlphaPointManifests({ manifestContent: fixture.manifest, fieldEvidenceContent: emptyEvidenceContent }),
    /has no v1 field evidence/,
  )
})

for (const [name, overrides, expectedError] of [
  ['unknown evidence schema', { schema_version: '2' }, /Unsupported field evidence schema/],
  ['poor GPS accuracy', { gps_accuracy_m: '50.1' }, /GPS accuracy must be within/],
  ['date-only timestamp', { measured_at: '2026-08-28' }, /timestamp must be ISO 8601 with timezone/],
  ['unsafe outcome', { safe_stop_outcome: 'relocate' }, /must have approved safe-stop outcome/],
  ['invalid evidence hash', { evidence_sha256: 'not-a-sha256' }, /Evidence SHA-256 must be 64 lowercase hex/],
  ['public evidence URL', { evidence_ref: 'https://example.test/private-photo.jpg' }, /opaque restricted\/ reference/],
  ['different canonical coordinates', { measured_latitude: '56.9000000' }, /must use measured safe-stop coordinates/],
]) {
  test(`fails closed for ${name}`, () => {
    const fixture = fieldVerifiedFixture()
    assert.throws(
      () =>
        validateAlphaPointManifests({
          manifestContent: fixture.manifest,
          fieldEvidenceContent: evidenceContent(overrides),
        }),
      expectedError,
    )
  })
}
