import { afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { DatabaseKabandaService } from '../src/kabandas.js'
import { DatabaseRaidService } from '../src/raids.js'
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null
const suite = pool ? describe : describe.skip
suite('existing raid setup', () => {
  afterAll(async () => { await pool?.end() })
  it('reschedules in place, replays safely, and rejects stale, unauthorized and started edits', async () => {
    const db = pool!
    const users = await db.query<{ id: string }>('INSERT INTO users (email) VALUES ($1), ($2) RETURNING id', [`${randomUUID()}@example.test`, `${randomUUID()}@example.test`])
    const owner = users.rows[0]!.id, other = users.rows[1]!.id
    const team = await new DatabaseKabandaService(db).createKabanda(owner, 'Setup test', '🐗', randomUUID())
    const service = new DatabaseRaidService(db, 'local-test-media-secret-at-least-32-bytes')
    const created = await service.createDraft(owner, team.id, { title: 'Now', openLobby: true, pointCategory: 'stores' }, randomUUID())
    const input = { expectedVersion: created.raid.version, title: 'Tomorrow', scheduledAt: new Date(Date.now()+86400000).toISOString(), meetingPlace: 'Park', description: 'Water' }
    const key = randomUUID()
    const changed = await service.updateSetup(owner, created.raid.id, input, key)
    expect(changed.raid).toMatchObject({ id: created.raid.id, state: 'planned', title: 'Tomorrow', meetingPlace: 'Park', pointCategory: 'stores' })
    expect(changed.raid.participants).toEqual(created.raid.participants)
    expect(await service.updateSetup(owner, created.raid.id, input, key)).toEqual(changed)
    expect((await db.query('SELECT count(*) FROM raids WHERE kabanda_id=$1', [team.id])).rows[0].count).toBe('1')
    await expect(service.updateSetup(owner, created.raid.id, input, randomUUID())).rejects.toMatchObject({ statusCode: 409 })
    await expect(service.updateSetup(other, created.raid.id, { ...input, expectedVersion: changed.raid.version }, randomUUID())).rejects.toBeDefined()
    await expect(service.updateSetup(owner, created.raid.id, { ...input, expectedVersion: changed.raid.version, scheduledAt: '2020-01-01T00:00:00Z' }, randomUUID())).rejects.toMatchObject({ statusCode: 400 })
    const now = await service.updateSetup(owner, created.raid.id, { ...input, expectedVersion: changed.raid.version, scheduledAt: null }, randomUUID())
    expect(now.raid.state).toBe('lobby')
    await db.query("UPDATE raids SET state='active', started_at=now() WHERE id=$1", [created.raid.id])
    await expect(service.updateSetup(owner, created.raid.id, { ...input, expectedVersion: now.raid.version }, randomUUID())).rejects.toMatchObject({ statusCode: 409 })
  })
})
