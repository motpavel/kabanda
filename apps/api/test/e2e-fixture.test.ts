import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import {
  assertE2EDatabaseGuard,
  requireE2EDatabaseUrl,
  requireE2ERunnerEnvironment,
} from '../src/e2e-fixture.js'

const validUrl = 'postgresql://kabanda_e2e:secret@127.0.0.1:5432/kabanda_e2e'
const validEnvironment = {
  NODE_ENV: 'test',
  KABANDA_E2E: 'true',
  E2E_RUN_ID: 'aa7936b3-bbb8-4c67-8148-a86bf8d0df28',
  E2E_DATABASE_URL: validUrl,
}

function guardPool(row: Record<string, unknown>): Pool {
  return {
    query: async () => ({ rows: [row] }),
  } as unknown as Pool
}

describe('fail-closed E2E database guard', () => {
  it('accepts only an exact loopback, least-privilege credential', () => {
    expect(requireE2EDatabaseUrl(validUrl)).toBe(validUrl)
    expect(() => requireE2EDatabaseUrl(validUrl.replace('127.0.0.1', 'db.internal')))
      .toThrow('host must be loopback')
    expect(() => requireE2EDatabaseUrl(validUrl.replace('kabanda_e2e:secret', 'postgres:secret')))
      .toThrow('user must be exactly')
    expect(() => requireE2EDatabaseUrl(validUrl.replace(':secret@', ':@')))
      .toThrow('password must be non-empty')
    expect(() => requireE2EDatabaseUrl(`${validUrl}?sslmode=disable`))
      .toThrow('options and fragments are forbidden')
  })

  it('requires all external runner markers', () => {
    expect(requireE2ERunnerEnvironment(validEnvironment)).toEqual({
      databaseUrl: validUrl,
      runId: validEnvironment.E2E_RUN_ID,
    })
    expect(() => requireE2ERunnerEnvironment({ ...validEnvironment, NODE_ENV: 'development' }))
      .toThrow('NODE_ENV=test')
    expect(() => requireE2ERunnerEnvironment({ ...validEnvironment, NODE_ENV: undefined }))
      .toThrow('NODE_ENV=test')
    expect(() => requireE2ERunnerEnvironment({ ...validEnvironment, KABANDA_E2E: undefined }))
      .toThrow('KABANDA_E2E=true')
    expect(() => requireE2ERunnerEnvironment({ ...validEnvironment, E2E_RUN_ID: undefined }))
      .toThrow('E2E_RUN_ID must be a UUID')
    expect(() => requireE2ERunnerEnvironment({ ...validEnvironment, E2E_DATABASE_URL: undefined }))
      .toThrow('E2E_DATABASE_URL is required')
  })

  it('rejects a wrong marker or privileged current role', async () => {
    const safeRow = {
      name: 'kabanda_e2e',
      username: 'kabanda_e2e',
      marker: 'kabanda-e2e-disposable-v1',
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
    }
    await expect(assertE2EDatabaseGuard(guardPool(safeRow))).resolves.toBeUndefined()
    await expect(assertE2EDatabaseGuard(guardPool({ ...safeRow, marker: 'wrong' })))
      .rejects.toThrow('marker or role capability mismatch')
    await expect(assertE2EDatabaseGuard(guardPool({ ...safeRow, username: 'postgres' })))
      .rejects.toThrow('marker or role capability mismatch')
    await expect(assertE2EDatabaseGuard(guardPool({ ...safeRow, rolsuper: true })))
      .rejects.toThrow('marker or role capability mismatch')
    await expect(assertE2EDatabaseGuard(guardPool({ ...safeRow, rolcreatedb: true })))
      .rejects.toThrow('marker or role capability mismatch')
  })
})
