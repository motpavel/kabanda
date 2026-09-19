import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PointMaterialService } from '../src/point-materials.js'

const fixture = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../src/field-service.js', () => ({
  canReadField: () => true,
  fieldAccess: vi.fn(async () => ({ state: 'active' })),
  fieldTransaction: async <T>(_pool: unknown, task: (client: PoolClient) => Promise<T>) => task({ query: fixture.query } as unknown as PoolClient),
}))
const bytes = Buffer.from('synthetic image content')
const sha = createHash('sha256').update(bytes).digest('hex')
const row = { id: 'photo', ordinal: '100', raid_id: 'raid', point_snapshot_id: 'point', author_user_id: 'user',
  operation_id: 'operation', kind: 'photo', body: 'Подпись', source_sha256: sha, declared_type: 'image/jpeg',
  declared_size: bytes.length, ready: true, width: 64, height: 48, created_at: new Date('2026-09-19T12:00:00Z') }
const pool = {} as Pool
function metadataQueries() {
  return fixture.query.mock.calls.map(call => String(call[0])).filter(sql => sql.includes('raid_point_materials'))
}
// Returning mockReset() would register the mock itself as cleanup, causing a
// spurious SQL call with no arguments after each otherwise successful test.
beforeEach(() => { fixture.query.mockReset() })

describe('point material metadata does not fetch photo contents', () => {
  it('lists 24 records and the exact cursor without selecting the binary column', async () => {
    fixture.query.mockImplementation(async (sql: string) => sql.includes('raid_point_snapshots') ? { rowCount: 1 } : {
      rows: Array.from({ length: 25 }, (_, i) => ({ ...row, id: `photo-${i}`, ordinal: String(100 - i), author_name: 'Автор' })),
    })
    const page = await new PointMaterialService(pool).list('user', 'raid', 'point')
    expect(page.materials).toHaveLength(24)
    expect(page.nextCursor).toBe('77')
    expect(page.materials[0]).toMatchObject({ authorName: 'Автор', width: 64, height: 48 })
    const sql = metadataQueries()[0]!
    const projection = sql.split(/FROM/i)[0]!
    expect(projection).not.toMatch(/\*|content_bytes/)
    expect(sql).toContain('m.ordinal DESC LIMIT 25')
    expect(fixture.query.mock.calls.at(-1)?.[1]).toEqual(['raid', 'point', null])
  })

  it('replays a completed upload using metadata without decoding or reading stored image bytes', async () => {
    fixture.query.mockImplementation(async (sql: string) => sql.includes('raid_point_snapshots') ? { rowCount: 1 } : { rows: [row] })
    const processor = vi.fn()
    const result = await new PointMaterialService(pool, processor).upload('user', 'raid', 'point', 'photo', bytes, sha)
    expect(result.material).toMatchObject({ id: 'photo', ready: true })
    expect(processor).not.toHaveBeenCalled()
    expect(metadataQueries()).toHaveLength(1)
    expect(metadataQueries()[0]!.split(/FROM/i)[0]).not.toMatch(/\*|content_bytes/)
  })

  it('writes processed bytes once but returns only metadata after rechecking ownership', async () => {
    fixture.query.mockImplementation(async (sql: string) => {
      if (sql.includes('raid_point_snapshots')) return { rowCount: 1 }
      return { rows: [{ ...row, ready: sql.startsWith('UPDATE') }] }
    })
    const processed = Buffer.from('processed image')
    const processor = vi.fn(async () => ({ data: processed, info: { width: 64, height: 48, channels: 3 as const, format: 'jpeg', size: processed.length, premultiplied: false } }))
    await new PointMaterialService(pool, processor).upload('user', 'raid', 'point', 'photo', bytes, sha)
    expect(processor).toHaveBeenCalledTimes(1)
    const queries = metadataQueries()
    for (const sql of queries.filter(sql => sql.startsWith('SELECT'))) expect(sql.split(/FROM/i)[0]).not.toMatch(/\*|content_bytes/)
    const update = queries.find(sql => sql.startsWith('UPDATE'))!
    expect(update).toContain('SET content_bytes=$2')
    expect(update.split('RETURNING')[1]).not.toMatch(/\*|content_bytes/)
    expect(queries.some(sql => sql.includes('FOR UPDATE'))).toBe(true)
  })

  it('keeps idempotency checks on the original photo metadata', async () => {
    fixture.query.mockImplementation(async (sql: string) => sql.includes('raid_point_snapshots') ? { rowCount: 1 } : { rows: [row] })
    const service = new PointMaterialService(pool)
    const input = { kind: 'photo' as const, body: row.body, sourceSha256: sha, contentType: 'image/jpeg' as const, sizeBytes: bytes.length }
    await expect(service.create('user', 'raid', 'point', 'operation', input)).resolves.toMatchObject({ material: { id: 'photo' } })
    await expect(service.create('user', 'raid', 'point', 'operation', { ...input, body: 'Другая подпись' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    for (const sql of metadataQueries()) expect(sql.split(/FROM/i)[0]).not.toMatch(/\*|content_bytes/)
  })

  it('the authorized content endpoint still reads the exact stored bytes', async () => {
    fixture.query.mockImplementation(async (sql: string) => sql.includes('raid_point_snapshots') ? { rowCount: 1 } : { rows: [{ content_bytes: bytes }] })
    await expect(new PointMaterialService(pool).read('user', 'raid', 'point', 'photo')).resolves.toEqual(bytes)
    expect(metadataQueries()[0]).toContain('SELECT content_bytes')
  })
})
