import { createHash } from 'node:crypto'
import type { CreateRaidTemplate } from '@kabanda/contracts'
import type { Pool, PoolClient } from 'pg'
import {
  processRaidTemplateCover,
  RaidTemplateCoverError,
  type ProcessedRaidTemplateCover,
} from './raid-template-cover.js'

export class RaidTemplateError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export type RaidTemplateEstimateProjection = {
  method: 'straight_segments'
  distanceMeters: number
}

export type RaidTemplateCoverProjection = {
  url: string
  sha256: string
  width: number
  height: number
}

export type RaidTemplateSummary = {
  id: string
  scope: 'kabanda' | 'all_authenticated'
  kabandaId: string
  title: string
  version: number
  cover: RaidTemplateCoverProjection
  pointCount: number
  estimate: RaidTemplateEstimateProjection
  createdAt: string
  updatedAt: string
}

export type RaidTemplatePointProjection = {
  id: string
  position: number
  name: string
  address: string
  comment: string
  latitude: number
  longitude: number
}

export type RaidTemplateProjection = RaidTemplateSummary & {
  points: RaidTemplatePointProjection[]
}

export type CreateRaidTemplateResponse = {
  receipt: {
    operationId: string
    command: 'create-raid-template'
    resultingVersion: number
    serverAt: string
  }
  template: RaidTemplateProjection
}

export type RaidTemplateCover = {
  bytes: Buffer
  contentType: 'image/jpeg'
  sha256: string
}

export interface RaidTemplateService {
  createTemplate(
    actorUserId: string,
    kabandaId: string,
    input: CreateRaidTemplate,
    operationId: string,
  ): Promise<CreateRaidTemplateResponse>
  listTemplates(actorUserId: string, kabandaId: string): Promise<RaidTemplateSummary[]>
  getTemplate(actorUserId: string, templateId: string): Promise<RaidTemplateProjection>
  readCover(actorUserId: string, templateId: string): Promise<RaidTemplateCover>
}

type RaidTemplateRow = {
  id: string
  scope: 'kabanda' | 'all_authenticated'
  kabanda_id: string
  title: string
  version: number
  point_count: number
  cover_sha256: string
  cover_width: number
  cover_height: number
  distance_method: 'straight_segments'
  estimated_distance_meters: number
  created_at: Date
  updated_at: Date
}

type CoverProcessor = (dataUrl: string) => Promise<ProcessedRaidTemplateCover>

function requestFingerprint(
  kabandaId: string,
  input: CreateRaidTemplate,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      command: 'create-raid-template',
      kabandaId,
      scope: input.scope,
      title: input.title,
      coverImage: input.coverImage,
      points: input.points,
    }))
    .digest('hex')
}

function legacyRequestFingerprint(
  kabandaId: string,
  input: CreateRaidTemplate,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      command: 'create-raid-template',
      kabandaId,
      title: input.title,
      coverImage: input.coverImage,
      points: input.points,
    }))
    .digest('hex')
}

const maximumActiveTemplatesPerKabanda = 100

const earthRadiusMeters = 6_371_000

function radians(degrees: number): number {
  return degrees * Math.PI / 180
}

export function straightSegmentsDistanceMeters(
  points: CreateRaidTemplate['points'],
): number {
  let distanceMeters = 0
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!
    const current = points[index]!
    const latitudeDelta = radians(current.latitude - previous.latitude)
    const longitudeDelta = radians(current.longitude - previous.longitude)
    const previousLatitude = radians(previous.latitude)
    const currentLatitude = radians(current.latitude)
    const haversine = Math.sin(latitudeDelta / 2) ** 2
      + Math.cos(previousLatitude) * Math.cos(currentLatitude)
      * Math.sin(longitudeDelta / 2) ** 2
    const boundedHaversine = Math.min(1, Math.max(0, haversine))
    distanceMeters += 2 * earthRadiusMeters * Math.atan2(
      Math.sqrt(boundedHaversine),
      Math.sqrt(1 - boundedHaversine),
    )
  }
  return Math.round(distanceMeters)
}

async function transaction<T>(pool: Pool, task: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await task(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

const templateSelect = `SELECT t.id, t.scope, t.kabanda_id,
  t.title, t.version, t.point_count, t.cover_sha256, t.cover_width, t.cover_height,
  t.distance_method, t.estimated_distance_meters, t.created_at, t.updated_at
 FROM raid_templates t`

export class DatabaseRaidTemplateService implements RaidTemplateService {
  constructor(
    private readonly pool: Pool,
    private readonly coverProcessor: CoverProcessor = processRaidTemplateCover,
  ) {}

  async createTemplate(
    actorUserId: string,
    kabandaId: string,
    input: CreateRaidTemplate,
    operationId: string,
  ): Promise<CreateRaidTemplateResponse> {
    const fingerprint = requestFingerprint(kabandaId, input)
    const acceptedReplayFingerprints = input.scope === 'kabanda'
      ? [fingerprint, legacyRequestFingerprint(kabandaId, input)]
      : [fingerprint]
    const estimatedDistanceMeters = straightSegmentsDistanceMeters(input.points)
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${actorUserId}:${operationId}`,
      ])
      const replay = await this.replay(
        client,
        actorUserId,
        operationId,
        acceptedReplayFingerprints,
      )
      if (replay) return replay

      const membership = await client.query(
        `SELECT 1 FROM kabanda_memberships m
         JOIN kabandas k ON k.id = m.kabanda_id AND k.archived_at IS NULL
         WHERE m.kabanda_id = $1 AND m.user_id = $2 AND m.removed_at IS NULL
         FOR UPDATE OF k, m`,
        [kabandaId, actorUserId],
      )
      if (!membership.rowCount) throw this.notFound()

      const activeTemplateCount = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM raid_templates
         WHERE kabanda_id = $1 AND archived_at IS NULL`,
        [kabandaId],
      )
      if (Number(activeTemplateCount.rows[0]?.count ?? 0) >= maximumActiveTemplatesPerKabanda) {
        throw new RaidTemplateError(
          'RAID_TEMPLATE_LIMIT_REACHED',
          409,
          `В Кабанде может быть не больше ${maximumActiveTemplatesPerKabanda} маршрутов`,
          { maximum: maximumActiveTemplatesPerKabanda },
        )
      }

      let cover: ProcessedRaidTemplateCover
      try {
        cover = await this.coverProcessor(input.coverImage)
      } catch (error) {
        if (error instanceof RaidTemplateCoverError) {
          throw new RaidTemplateError(error.code, 400, error.message)
        }
        throw error
      }

      const inserted = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO raid_templates
          (kabanda_id, scope, created_by_user_id, title, point_count,
           cover_bytes, cover_content_type, cover_size_bytes, cover_width, cover_height,
           cover_sha256, distance_method, estimated_distance_meters)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           'straight_segments', $12)
         RETURNING id, created_at`,
        [
          kabandaId,
          input.scope,
          actorUserId,
          input.title,
          input.points.length,
          cover.bytes,
          cover.contentType,
          cover.sizeBytes,
          cover.width,
          cover.height,
          cover.sha256,
          estimatedDistanceMeters,
        ],
      )
      const template = inserted.rows[0]
      if (!template) throw new Error('Raid template create did not return a row')

      const points = input.points.map((point, position) => ({ ...point, position }))
      await client.query(
        `INSERT INTO raid_template_points
          (template_id, position, name, address, comment, location)
         SELECT $1, point.position, point.name, point.address, point.comment,
           ST_SetSRID(ST_MakePoint(point.longitude, point.latitude), 4326)::geography
         FROM jsonb_to_recordset($2::jsonb) AS point(
           position smallint,
           name text,
           address text,
           comment text,
           latitude double precision,
           longitude double precision
         )`,
        [template.id, JSON.stringify(points)],
      )

      const response: CreateRaidTemplateResponse = {
        receipt: {
          operationId,
          command: 'create-raid-template',
          resultingVersion: 1,
          serverAt: template.created_at.toISOString(),
        },
        template: await this.project(client, template.id),
      }
      await client.query(
        `INSERT INTO raid_template_receipts
          (actor_user_id, operation_id, template_id, command, request_fingerprint,
           resulting_version, response_json)
         VALUES ($1, $2, $3, 'create-raid-template', $4, 1, $5)`,
        [actorUserId, operationId, template.id, fingerprint, response],
      )
      return response
    })
  }

  async listTemplates(actorUserId: string, kabandaId: string): Promise<RaidTemplateSummary[]> {
    return transaction(this.pool, async (client) => {
      const membership = await client.query(
        `SELECT 1 FROM kabanda_memberships m
         JOIN kabandas k ON k.id = m.kabanda_id AND k.archived_at IS NULL
         WHERE m.kabanda_id = $1 AND m.user_id = $2 AND m.removed_at IS NULL
         FOR SHARE OF k, m`,
        [kabandaId, actorUserId],
      )
      if (!membership.rowCount) throw this.notFound()
      const result = await client.query<RaidTemplateRow>(
        `${templateSelect}
         JOIN kabandas source_kabanda
           ON source_kabanda.id = t.kabanda_id AND source_kabanda.archived_at IS NULL
         WHERE t.archived_at IS NULL
           AND (t.scope = 'all_authenticated' OR (t.scope = 'kabanda' AND t.kabanda_id = $1))
         ORDER BY t.updated_at DESC, t.id DESC
         LIMIT 100`,
        [kabandaId],
      )
      return result.rows.map((row) => this.summary(row))
    })
  }

  async getTemplate(actorUserId: string, templateId: string): Promise<RaidTemplateProjection> {
    return transaction(this.pool, async (client) => {
      await this.visibleTemplate(client, actorUserId, templateId)
      return this.project(client, templateId)
    })
  }

  async readCover(actorUserId: string, templateId: string): Promise<RaidTemplateCover> {
    const result = await this.pool.query<{
      cover_bytes: Buffer
      cover_content_type: 'image/jpeg'
      cover_sha256: string
    }>(
      `SELECT t.cover_bytes, t.cover_content_type, t.cover_sha256
       FROM raid_templates t
       JOIN kabandas k ON k.id = t.kabanda_id AND k.archived_at IS NULL
       WHERE t.id = $1 AND t.archived_at IS NULL
         AND (
           t.scope = 'all_authenticated'
           OR EXISTS (
             SELECT 1 FROM kabanda_memberships m
             WHERE m.kabanda_id = t.kabanda_id
               AND m.user_id = $2 AND m.removed_at IS NULL
           )
         )`,
      [templateId, actorUserId],
    )
    const cover = result.rows[0]
    if (!cover) throw this.notFound()
    return {
      bytes: cover.cover_bytes,
      contentType: 'image/jpeg',
      sha256: cover.cover_sha256,
    }
  }

  private async replay(
    client: PoolClient,
    actorUserId: string,
    operationId: string,
    acceptedFingerprints: readonly string[],
  ): Promise<CreateRaidTemplateResponse | null> {
    const result = await client.query<{
      request_fingerprint: string
      response_json: CreateRaidTemplateResponse
      access_active: boolean
    }>(
      `SELECT receipt.request_fingerprint, receipt.response_json,
         (template.archived_at IS NULL AND kabanda.archived_at IS NULL
           AND membership.user_id IS NOT NULL) AS access_active
       FROM raid_template_receipts receipt
       JOIN raid_templates template ON template.id = receipt.template_id
       JOIN kabandas kabanda ON kabanda.id = template.kabanda_id
       LEFT JOIN kabanda_memberships membership
         ON membership.kabanda_id = template.kabanda_id
           AND membership.user_id = $1 AND membership.removed_at IS NULL
       WHERE receipt.actor_user_id = $1 AND receipt.operation_id = $2`,
      [actorUserId, operationId],
    )
    const receipt = result.rows[0]
    if (!receipt) return null
    if (!receipt.access_active) throw this.notFound()
    if (!acceptedFingerprints.includes(receipt.request_fingerprint)) {
      throw new RaidTemplateError(
        'RAID_TEMPLATE_IDEMPOTENCY_CONFLICT',
        409,
        'Ключ уже использован для другого шаблона',
      )
    }
    return receipt.response_json
  }

  private async visibleTemplate(
    client: PoolClient,
    actorUserId: string,
    templateId: string,
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM raid_templates template
       JOIN kabandas kabanda
         ON kabanda.id = template.kabanda_id AND kabanda.archived_at IS NULL
       WHERE template.id = $1 AND template.archived_at IS NULL
         AND (
           template.scope = 'all_authenticated'
           OR EXISTS (
             SELECT 1 FROM kabanda_memberships membership
             WHERE membership.kabanda_id = template.kabanda_id
               AND membership.user_id = $2 AND membership.removed_at IS NULL
           )
         )
       FOR SHARE OF template, kabanda`,
      [templateId, actorUserId],
    )
    if (!result.rowCount) throw this.notFound()
  }

  private async project(client: PoolClient, templateId: string): Promise<RaidTemplateProjection> {
    const templateResult = await client.query<RaidTemplateRow>(
      `${templateSelect} WHERE t.id = $1 AND t.archived_at IS NULL`,
      [templateId],
    )
    const row = templateResult.rows[0]
    if (!row) throw this.notFound()
    const points = await client.query<{
      id: string
      position: number
      name: string
      address: string
      comment: string
      latitude: number
      longitude: number
    }>(
      `SELECT id, position, name, address, comment,
         ST_Y(location::geometry) AS latitude,
         ST_X(location::geometry) AS longitude
       FROM raid_template_points
       WHERE template_id = $1
       ORDER BY position`,
      [templateId],
    )
    return {
      ...this.summary(row),
      points: points.rows.map((point) => ({
        id: point.id,
        position: Number(point.position),
        name: point.name,
        address: point.address,
        comment: point.comment,
        latitude: Number(point.latitude),
        longitude: Number(point.longitude),
      })),
    }
  }

  private summary(row: RaidTemplateRow): RaidTemplateSummary {
    return {
      id: row.id,
      scope: row.scope,
      kabandaId: row.kabanda_id,
      title: row.title,
      version: Number(row.version),
      cover: {
        url: `/api/raid-templates/${encodeURIComponent(row.id)}/cover`,
        sha256: row.cover_sha256,
        width: Number(row.cover_width),
        height: Number(row.cover_height),
      },
      pointCount: Number(row.point_count),
      estimate: {
        method: row.distance_method,
        distanceMeters: Number(row.estimated_distance_meters),
      },
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }
  }

  private notFound(): RaidTemplateError {
    return new RaidTemplateError('RAID_TEMPLATE_NOT_FOUND', 404, 'Шаблон рейда не найден')
  }
}
