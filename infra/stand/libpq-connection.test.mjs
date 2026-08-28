import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { test } from 'node:test'

const helper = new URL('./libpq-connection.mjs', import.meta.url)

test('emits bounded libpq fields without putting credentials in argv', () => {
  const secret = 'bounded-secret'
  const output = execFileSync(process.execPath, [helper.pathname], {
    env: {
      DATABASE_URL: `postgresql://kabanda_preview:${secret}@127.0.0.1:5432/kabanda_preview`,
    },
  })
  assert.deepEqual(output.toString().split('\0').filter(Boolean), [
    '127.0.0.1',
    '5432',
    'kabanda_preview',
    secret,
    'kabanda_preview',
  ])
})

test('rejects non-loopback and incomplete database URLs', () => {
  for (const databaseUrl of [
    'postgresql://user:secret@database.example/kabanda',
    'postgresql://user@127.0.0.1/kabanda',
    'postgresql://user:secret@127.0.0.1/kabanda?host=database.example',
    'postgresql://user:secret@127.0.0.1/kabanda#override',
  ]) {
    const result = spawnSync(process.execPath, [helper.pathname], {
      env: { DATABASE_URL: databaseUrl },
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
  }
})

test('does not echo credentials from a malformed URL', () => {
  const secret = 'must-not-reach-stderr'
  const result = spawnSync(process.execPath, [helper.pathname], {
    env: { DATABASE_URL: `not-a-url-${secret}` },
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'Invalid stand DATABASE_URL\n')
  assert.equal(result.stderr.includes(secret), false)
})
