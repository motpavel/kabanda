import { createHash, randomUUID } from 'node:crypto'
import type { CreateRaidTemplate } from '@kabanda/contracts'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { DatabaseRaidTemplateService } from '../src/raid-templates.js'

const databaseUrl = process.env.DATABASE_URL
const describePostgres = databaseUrl ? describe : describe.skip
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null
const normalizedCoverBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
const normalizedCoverSha256 = createHash('sha256').update(normalizedCoverBytes).digest('hex')
const raidTemplates = pool
  ? new DatabaseRaidTemplateService(pool, async () => ({
      bytes: normalizedCoverBytes,
      contentType: 'image/jpeg',
      sizeBytes: normalizedCoverBytes.length,
      width: 1_280,
      height: 720,
      sha256: normalizedCoverSha256,
    }))
  : null

async function createUser(label: string): Promise<string> {
  const result = await pool!.query<{ id: string }>(
    'INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id',
    [`${label}-${randomUUID()}@example.com`, label],
  )
  return result.rows[0]!.id
}

async function createKabanda(label: string) {
  const ownerId = await createUser(`owner-${label}`)
  const created = await pool!.query<{ id: string }>(
    `INSERT INTO kabandas (name, avatar, owner_id, create_idempotency_key)
     VALUES ($1, '🐗', $2, $3)
     RETURNING id`,
    [`Кабанда ${label}`, ownerId, `kabanda-${randomUUID()}`],
  )
  const kabandaId = created.rows[0]!.id
  await pool!.query(
    `INSERT INTO kabanda_memberships (kabanda_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [kabandaId, ownerId],
  )
  return { ownerId, kabandaId }
}

async function addMember(kabandaId: string, label: string): Promise<string> {
  const memberId = await createUser(`member-${label}`)
  await pool!.query(
    `INSERT INTO kabanda_memberships (kabanda_id, user_id, role)
     VALUES ($1, $2, 'member')`,
    [kabandaId, memberId],
  )
  return memberId
}

function input(title = 'Набережные и мосты'): CreateRaidTemplate {
  return {
    scope: 'kabanda',
    title,
    coverImage: 'data:image/jpeg;base64,transport-is-never-stored',
    points: [
      {
        name: 'Старт у ротонды',
        address: 'Набережная, 1',
        comment: 'Подождать всех',
        latitude: 56.85001,
        longitude: 53.20001,
      },
      {
        name: 'Финиш у моста',
        address: 'Мостовая, 2',
        comment: '',
        latitude: 56.86002,
        longitude: 53.21002,
      },
    ],
  }
}

function legacyFingerprint(kabandaId: string, value: CreateRaidTemplate): string {
  return createHash('sha256')
    .update(JSON.stringify({
      command: 'create-raid-template',
      kabandaId,
      title: value.title,
      coverImage: value.coverImage,
      points: value.points,
    }))
    .digest('hex')
}

describePostgres('raid template PostgreSQL invariants', () => {
  beforeEach(async () => {
    await pool!.query(
      `TRUNCATE raid_template_receipts, raid_template_points, raid_templates,
       raid_participants, raids, kabanda_memberships, kabandas, users CASCADE`,
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('lets any active member create and read an ordered template without creating a raid', async () => {
    const { ownerId, kabandaId } = await createKabanda('member-author')
    const memberId = await addMember(kabandaId, 'author')

    const created = await raidTemplates!.createTemplate(
      memberId,
      kabandaId,
      input(),
      'member-template-operation',
    )

    expect(created.receipt).toMatchObject({
      operationId: 'member-template-operation',
      command: 'create-raid-template',
      resultingVersion: 1,
    })
    expect(created.template).toMatchObject({
      scope: 'kabanda',
      kabandaId,
      title: 'Набережные и мосты',
      version: 1,
      pointCount: 2,
      cover: {
        url: `/api/raid-templates/${created.template.id}/cover`,
        sha256: normalizedCoverSha256,
        width: 1_280,
        height: 720,
      },
      estimate: {
        method: 'straight_segments',
        distanceMeters: 1_269,
      },
    })
    expect(created.template.points.map((point) => [point.position, point.name])).toEqual([
      [0, 'Старт у ротонды'],
      [1, 'Финиш у моста'],
    ])
    expect(JSON.stringify(created)).not.toContain('data:image')

    const ownerCatalog = await raidTemplates!.listTemplates(ownerId, kabandaId)
    expect(ownerCatalog).toEqual([
      expect.objectContaining({ id: created.template.id, pointCount: 2 }),
    ])
    expect(ownerCatalog[0]).not.toHaveProperty('points')
    await expect(
      raidTemplates!.getTemplate(ownerId, created.template.id),
    ).resolves.toEqual(created.template)
    const cover = await raidTemplates!.readCover(memberId, created.template.id)
    expect(cover).toEqual({
      bytes: normalizedCoverBytes,
      contentType: 'image/jpeg',
      sha256: normalizedCoverSha256,
    })

    expect(Number((await pool!.query('SELECT count(*) FROM raids')).rows[0]!.count)).toBe(0)
    expect(Number((await pool!.query('SELECT count(*) FROM raid_participants')).rows[0]!.count)).toBe(0)
    const stored = await pool!.query<{
      cover_bytes: Buffer
      point_count: number
      distance_method: string
      estimated_distance_meters: number
      archived_at: Date | null
    }>(
      `SELECT cover_bytes, point_count, distance_method, estimated_distance_meters,
         archived_at
       FROM raid_templates WHERE id = $1`,
      [created.template.id],
    )
    expect(stored.rows[0]).toMatchObject({
      cover_bytes: normalizedCoverBytes,
      point_count: 2,
      distance_method: 'straight_segments',
      estimated_distance_meters: 1_269,
      archived_at: null,
    })
  })

  it('replays the same idempotent create and rejects a changed request', async () => {
    const { kabandaId } = await createKabanda('idempotency')
    const memberId = await addMember(kabandaId, 'idempotency')
    const coverProcessor = vi.fn(async () => ({
      bytes: normalizedCoverBytes,
      contentType: 'image/jpeg' as const,
      sizeBytes: normalizedCoverBytes.length,
      width: 1_280,
      height: 720,
      sha256: normalizedCoverSha256,
    }))
    const idempotentService = new DatabaseRaidTemplateService(pool!, coverProcessor)

    const [first, replay] = await Promise.all([
      idempotentService.createTemplate(memberId, kabandaId, input(), 'same-template-operation'),
      idempotentService.createTemplate(memberId, kabandaId, input(), 'same-template-operation'),
    ])
    expect(replay).toEqual(first)
    expect(coverProcessor).toHaveBeenCalledOnce()
    expect(
      Number((await pool!.query('SELECT count(*) FROM raid_templates')).rows[0]!.count),
    ).toBe(1)
    expect(
      Number((await pool!.query('SELECT count(*) FROM raid_template_points')).rows[0]!.count),
    ).toBe(2)

    await expect(
      idempotentService.createTemplate(
        memberId,
        kabandaId,
        input('Другой маршрут'),
        'same-template-operation',
      ),
    ).rejects.toMatchObject({
      code: 'RAID_TEMPLATE_IDEMPOTENCY_CONFLICT',
      statusCode: 409,
    })
    expect(coverProcessor).toHaveBeenCalledOnce()
  })

  it('replays a private create receipt written before visibility existed', async () => {
    const { kabandaId } = await createKabanda('legacy-idempotency')
    const memberId = await addMember(kabandaId, 'legacy-idempotency')
    const value = input('Старый закрытый маршрут')
    const operationId = 'legacy-template-operation'
    const created = await raidTemplates!.createTemplate(memberId, kabandaId, value, operationId)
    await pool!.query(
      `UPDATE raid_template_receipts
       SET request_fingerprint = $1
       WHERE actor_user_id = $2 AND operation_id = $3`,
      [legacyFingerprint(kabandaId, value), memberId, operationId],
    )

    await expect(
      raidTemplates!.createTemplate(memberId, kabandaId, value, operationId),
    ).resolves.toEqual(created)
    await expect(
      raidTemplates!.createTemplate(
        memberId,
        kabandaId,
        { ...value, title: 'Подменённый маршрут' },
        operationId,
      ),
    ).rejects.toMatchObject({
      code: 'RAID_TEMPLATE_IDEMPOTENCY_CONFLICT',
      statusCode: 409,
    })
  })

  it('shows a public template to another Kabanda but keeps a private template inside its own', async () => {
    const source = await createKabanda('visibility-source')
    const target = await createKabanda('visibility-target')
    const publicTemplate = await raidTemplates!.createTemplate(
      source.ownerId,
      source.kabandaId,
      { ...input('Общий маршрут'), scope: 'all_authenticated' },
      'public-template-operation',
    )
    const privateTemplate = await raidTemplates!.createTemplate(
      source.ownerId,
      source.kabandaId,
      input('Маршрут для своих'),
      'private-template-operation',
    )

    await expect(raidTemplates!.listTemplates(target.ownerId, target.kabandaId)).resolves.toEqual([
      expect.objectContaining({ id: publicTemplate.template.id, scope: 'all_authenticated' }),
    ])
    await expect(
      raidTemplates!.getTemplate(target.ownerId, publicTemplate.template.id),
    ).resolves.toMatchObject({ id: publicTemplate.template.id, scope: 'all_authenticated' })
    await expect(
      raidTemplates!.readCover(target.ownerId, publicTemplate.template.id),
    ).resolves.toMatchObject({ sha256: normalizedCoverSha256 })
    await expect(
      raidTemplates!.getTemplate(target.ownerId, privateTemplate.template.id),
    ).rejects.toMatchObject({ code: 'RAID_TEMPLATE_NOT_FOUND', statusCode: 404 })
    await expect(
      raidTemplates!.readCover(target.ownerId, privateTemplate.template.id),
    ).rejects.toMatchObject({ code: 'RAID_TEMPLATE_NOT_FOUND', statusCode: 404 })

    await pool!.query('UPDATE kabandas SET archived_at = now() WHERE id = $1', [source.kabandaId])
    await expect(
      raidTemplates!.getTemplate(target.ownerId, publicTemplate.template.id),
    ).rejects.toMatchObject({ code: 'RAID_TEMPLATE_NOT_FOUND', statusCode: 404 })
    await expect(raidTemplates!.listTemplates(target.ownerId, target.kabandaId)).resolves.toEqual([])
  })

  it('caps active templates per Kabanda before processing another cover', async () => {
    const { kabandaId } = await createKabanda('limit')
    const memberId = await addMember(kabandaId, 'limit')
    await pool!.query(
      `WITH inserted AS (
         INSERT INTO raid_templates
           (kabanda_id, created_by_user_id, title, point_count,
            cover_bytes, cover_content_type, cover_size_bytes, cover_width, cover_height,
            cover_sha256, distance_method, estimated_distance_meters)
         SELECT $1, $2, 'Маршрут ' || sequence, 2,
           $3, 'image/jpeg', $4, 1280, 720, $5, 'straight_segments', 1000
         FROM generate_series(1, 100) AS sequence
         RETURNING id
       )
       INSERT INTO raid_template_points
         (template_id, position, name, address, comment, location)
       SELECT inserted.id, point.position, point.name, point.address, '',
         ST_SetSRID(ST_MakePoint(point.longitude, point.latitude), 4326)::geography
       FROM inserted
       CROSS JOIN (VALUES
         (0::smallint, 'Старт'::text, 'Адрес 1'::text, 53.2::double precision, 56.85::double precision),
         (1::smallint, 'Финиш'::text, 'Адрес 2'::text, 53.21::double precision, 56.86::double precision)
       ) AS point(position, name, address, longitude, latitude)`,
      [
        kabandaId,
        memberId,
        normalizedCoverBytes,
        normalizedCoverBytes.length,
        normalizedCoverSha256,
      ],
    )
    const coverProcessor = vi.fn(async () => {
      throw new Error('cover processing must not run after the limit is reached')
    })
    const limitedService = new DatabaseRaidTemplateService(pool!, coverProcessor)

    await expect(
      limitedService.createTemplate(memberId, kabandaId, input(), 'limit-operation'),
    ).rejects.toMatchObject({
      code: 'RAID_TEMPLATE_LIMIT_REACHED',
      statusCode: 409,
      details: { maximum: 100 },
    })
    expect(coverProcessor).not.toHaveBeenCalled()
  })

  it('returns the same 404 to outsiders and removed members on every operation', async () => {
    const { ownerId, kabandaId } = await createKabanda('hidden')
    const memberId = await addMember(kabandaId, 'removed')
    const outsiderId = await createUser('outsider')
    const created = await raidTemplates!.createTemplate(
      ownerId,
      kabandaId,
      input(),
      'hidden-template-operation',
    )
    await pool!.query(
      `UPDATE kabanda_memberships SET removed_at = now()
       WHERE kabanda_id = $1 AND user_id = $2`,
      [kabandaId, memberId],
    )

    for (const hiddenUserId of [outsiderId, memberId]) {
      const attempts = [
        () => raidTemplates!.createTemplate(
          hiddenUserId,
          kabandaId,
          input('Скрытый маршрут'),
          `hidden-${hiddenUserId}`,
        ),
        () => raidTemplates!.listTemplates(hiddenUserId, kabandaId),
        () => raidTemplates!.getTemplate(hiddenUserId, created.template.id),
        () => raidTemplates!.readCover(hiddenUserId, created.template.id),
      ]
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toMatchObject({
          code: 'RAID_TEMPLATE_NOT_FOUND',
          statusCode: 404,
        })
      }
    }
  })
})
