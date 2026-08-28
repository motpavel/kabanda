import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  expectedFieldEvidenceHeader,
  validateAlphaPointManifests,
  validateAlphaPointManifestsWithArtifacts,
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

test('requires the actual restricted artifact and verifies its SHA-256 before field_verified import', async (context) => {
  const fixture = fieldVerifiedFixture()
  const evidenceBytes = Buffer.from('{"safeStop":"approved","version":1}')
  const actualSha256 = createHash('sha256').update(evidenceBytes).digest('hex')
  const evidenceRef = `restricted/alpha-points/${fixture.pointId}/evidence.json`
  const root = await mkdtemp(join(tmpdir(), 'kabanda-field-evidence-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const artifactPath = join(root, evidenceRef)
  await mkdir(dirname(artifactPath), { recursive: true })
  await writeFile(artifactPath, evidenceBytes)

  await assert.doesNotReject(() => validateAlphaPointManifestsWithArtifacts({
    manifestContent: fixture.manifest,
    fieldEvidenceContent: evidenceContent({ evidence_sha256: actualSha256, evidence_ref: evidenceRef }),
    evidenceRoot: root,
  }))
  await assert.rejects(
    () => validateAlphaPointManifestsWithArtifacts({
      manifestContent: fixture.manifest,
      fieldEvidenceContent: evidenceContent({ evidence_sha256: 'b'.repeat(64), evidence_ref: evidenceRef }),
      evidenceRoot: root,
    }),
    /hash mismatch/,
  )
})

test('fails closed for a missing artifact or missing restricted root', async (context) => {
  const fixture = fieldVerifiedFixture()
  const root = await mkdtemp(join(tmpdir(), 'kabanda-field-evidence-missing-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const input = {
    manifestContent: fixture.manifest,
    fieldEvidenceContent: evidenceContent(),
  }
  await assert.rejects(
    () => validateAlphaPointManifestsWithArtifacts({ ...input, evidenceRoot: root }),
    /evidence is unavailable/,
  )
  await assert.rejects(
    () => validateAlphaPointManifestsWithArtifacts(input),
    /ALPHA_FIELD_EVIDENCE_ROOT/,
  )
})

test('rejects lexical and symlink traversal outside the restricted evidence root', async (context) => {
  const fixture = fieldVerifiedFixture()
  await assert.rejects(
    () => validateAlphaPointManifestsWithArtifacts({
      manifestContent: fixture.manifest,
      fieldEvidenceContent: evidenceContent({ evidence_ref: 'restricted/../outside.json' }),
      evidenceRoot: '/tmp',
    }),
    /opaque restricted\/ reference/,
  )

  const root = await mkdtemp(join(tmpdir(), 'kabanda-field-evidence-link-'))
  const outside = await mkdtemp(join(tmpdir(), 'kabanda-field-evidence-outside-'))
  context.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]))
  const outsideArtifact = join(outside, 'evidence.json')
  await writeFile(outsideArtifact, 'outside')
  const evidenceRef = `restricted/alpha-points/${fixture.pointId}/evidence.json`
  const linkPath = join(root, evidenceRef)
  await mkdir(dirname(linkPath), { recursive: true })
  await symlink(outsideArtifact, linkPath)
  await assert.rejects(
    () => validateAlphaPointManifestsWithArtifacts({
      manifestContent: fixture.manifest,
      fieldEvidenceContent: evidenceContent({ evidence_ref: evidenceRef }),
      evidenceRoot: root,
    }),
    /evidence is unavailable/,
  )
})
