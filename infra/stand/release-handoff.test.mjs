import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
for (const directory of ['infra/release', 'infra/yandex']) {
  test(`${directory}: release safety and existing deployment helpers`, { timeout: 120_000 }, () => {
    const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', directory, '-p', 'test_*.py', '-v'], {
      cwd: root, encoding: 'utf8', timeout: 110_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    process.stdout.write(result.stdout + result.stderr)
  })
}
