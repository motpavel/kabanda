import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { DatabaseRaidService } from '../src/raids.js'

// Temporary tables isolate the gallery SQL from application data and PostGIS.
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 1 }) : null
const suite = pool ? describe : describe.skip
suite('completed raid gallery SQL', () => {
  const user = randomUUID(), team = randomUUID(), raid = randomUUID(), otherRaid = randomUUID()
  const legacy = randomUUID(), pointPhoto = randomUUID(), pending = randomUUID()
  const service = pool ? new DatabaseRaidService(pool, 'gallery-test-secret-at-least-32-characters') : null
  beforeAll(async () => {
    await pool!.query(`
      CREATE TEMP TABLE kabandas (id uuid, archived_at timestamptz);
      CREATE TEMP TABLE kabanda_memberships (kabanda_id uuid, user_id uuid, role text, removed_at timestamptz);
      CREATE TEMP TABLE raids (id uuid, kabanda_id uuid, state text);
      CREATE TEMP TABLE raid_participants (raid_id uuid, user_id uuid, state text);
      CREATE TEMP TABLE raid_media (id uuid, raid_id uuid, uploader_user_id uuid, state text, content_type text,
        size_bytes integer, width integer, height integer, caption text, purpose text, created_at timestamptz, content_bytes bytea);
      CREATE TEMP TABLE raid_point_materials (id uuid, raid_id uuid, author_user_id uuid, kind text, ready boolean,
        width integer, height integer, body text, created_at timestamptz, content_bytes bytea);
    `)
    await pool!.query("INSERT INTO kabandas VALUES ($1,null)", [team])
    await pool!.query("INSERT INTO kabanda_memberships VALUES ($1,$2,'owner',null)", [team, user])
    await pool!.query("INSERT INTO raids VALUES ($1,$2,'completed'),($3,$2,'completed')", [raid, team, otherRaid])
    await pool!.query("INSERT INTO raid_media VALUES ($1,$2,$3,'ready','image/jpeg',6,20,20,'Общее фото','gallery','2026-09-20T10:00:00Z',$4)", [legacy, raid, user, Buffer.from('legacy')])
    for (const [id, scope, kind, ready, at] of [
      [pointPhoto, raid, 'photo', true, '12:00'], [pending, raid, 'photo', false, '13:00'],
      [randomUUID(), raid, 'comment', true, '14:00'], [randomUUID(), otherRaid, 'photo', true, '15:00'],
    ] as const) await pool!.query('INSERT INTO raid_point_materials VALUES ($1,$2,$3,$4,$5,20,20,$6,$7,$8)',
      [id, scope, user, kind, ready, 'Фото с точки', `2026-09-20T${at}:00Z`, Buffer.from('point')])
  })
  afterAll(async () => { await pool?.end() })
  it('combines photos in chronological pages without comments, pending uploads or another raid', async () => {
    const first = await service!.listMedia(user, raid, 1)
    expect(first.media).toMatchObject([{ id: pointPhoto, caption: 'Фото с точки', sizeBytes: 5, state: 'ready' }])
    expect(first.nextCursor).not.toBeNull()
    const second = await service!.listMedia(user, raid, 1, first.nextCursor!)
    expect(second.media.map(item => item.id)).toEqual([legacy])
    expect(second.nextCursor).toBeNull()
    expect((await service!.listMedia(user, raid, 24)).media.map(item => item.id)).toEqual([pointPhoto, legacy])
  })
  it('serves both image stores and refuses unavailable or mismatched photos', async () => {
    expect((await service!.readMedia(user, raid, pointPhoto)).bytes).toEqual(Buffer.from('point'))
    expect((await service!.readMedia(user, raid, legacy)).bytes).toEqual(Buffer.from('legacy'))
    await expect(service!.readMedia(user, raid, pending)).rejects.toMatchObject({ statusCode: 404 })
    await expect(service!.readMedia(user, otherRaid, pointPhoto)).rejects.toMatchObject({ statusCode: 404 })
    await expect(service!.listMedia(randomUUID(), raid, 24)).rejects.toMatchObject({ statusCode: 404 })
    await expect(service!.readMedia(randomUUID(), raid, pointPhoto)).rejects.toMatchObject({ statusCode: 404 })
  })
  it('preserves the active-raid gallery contract', async () => {
    await pool!.query("UPDATE raids SET state='active' WHERE id=$1", [raid])
    expect((await service!.listMedia(user, raid, 24)).media.map(item => item.id)).toEqual([legacy])
    await expect(service!.readMedia(user, raid, pointPhoto)).rejects.toMatchObject({ statusCode: 404 })
  })
})
