import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('../..', import.meta.url))
test('field release preparation gates use exact CI and never expose runtime secrets', () => {
  const r = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'infra/release', '-p', 'test_prepare_field_release.py', '-v'], {
    cwd, encoding: 'utf8', timeout: 15_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  process.stdout.write(r.stdout + r.stderr)
})
test('read-only field runtime probe parses without executing it', () => {
  const r = spawnSync(process.execPath, ['--check', 'infra/release/runtime_field_check.mjs'], { cwd, encoding: 'utf8', timeout: 10_000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
