import { z } from 'zod'

export const userSchema = z.object({
  id: z.uuid(),
  email: z.email().nullable(),
  username: z.string().min(3).max(32).nullable(),
  identityKind: z.enum(['verified', 'invite']),
  displayName: z.string().min(1).max(80).nullable(),
  avatarUrl: z.url().nullable(),
})

export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[\p{L}\p{N}._-]+$/u)

export const passwordSchema = z.string().min(8).max(128)

export const passwordLoginSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
}).strict()

export const requestMagicLinkSchema = z.object({
  email: z.email().max(254),
  returnTo: z.string().max(500).default('/'),
})

export const verifyMagicLinkSchema = z.object({
  token: z.string().min(32).max(256),
})

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  avatarUrl: z.url().max(2_000).nullable().optional(),
})

export const idempotencyKeySchema = z.string().trim().min(8).max(100)

export const buildIdentifierSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)
export const operationReferenceSchema = z.string().regex(/^[a-f0-9]{16}$/)

const diagnosticCommonShape = {
  schemaVersion: z.literal(1),
  signalId: z.uuid(),
  diagnosticSessionId: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
  clientBuild: buildIdentifierSchema,
  swBuild: buildIdentifierSchema.nullable(),
  displayMode: z.enum(['browser', 'standalone']),
  operationRef: operationReferenceSchema.optional(),
}

const attemptBucketSchema = z.enum(['0_2', '3_5', '6_plus'])
const errorClassSchema = z.enum(['network', 'auth', 'conflict', 'server', 'storage', 'unknown'])

export const alphaDiagnosticSignalSchema = z.discriminatedUnion('kind', [
  z.object({
    ...diagnosticCommonShape,
    kind: z.literal('gps_stale'),
    ageBucket: z.enum(['15_30s', '30_60s', '1_5m', '5m_plus', 'unknown']),
  }).strict(),
  z.object({
    ...diagnosticCommonShape,
    kind: z.literal('gps_stopped'),
    reason: z.enum([
      'permission_denied',
      'position_unavailable',
      'timeout',
      'storage_error',
      'lease_lost',
      'page_hidden',
      'raid_paused',
      'raid_closed',
      'unknown',
    ]),
  }).strict(),
  z.object({
    ...diagnosticCommonShape,
    kind: z.literal('queue_stalled'),
    queue: z.enum(['route', 'checkin', 'media']),
    countBucket: z.enum(['1', '2_5', '6_20', '21_100', '100_plus']),
    oldestAgeBucket: z.enum(['2_5m', '5_15m', '15m_plus']),
    attemptBucket: attemptBucketSchema,
    errorClass: errorClassSchema,
  }).strict(),
  z.object({
    ...diagnosticCommonShape,
    kind: z.literal('media_failed'),
    stage: z.enum(['intent', 'upload', 'processing', 'local_storage']),
    terminal: z.boolean(),
    attemptBucket: attemptBucketSchema,
    errorClass: errorClassSchema,
  }).strict(),
  z.object({
    ...diagnosticCommonShape,
    kind: z.literal('sw_mismatch'),
    state: z.enum(['waiting_deferred', 'controller_missing', 'controller_changed']),
    durableWorkBucket: z.enum(['0', '1_5', '6_20', '21_plus']),
    recorderActive: z.boolean(),
    activeSwBuild: buildIdentifierSchema.nullable(),
    waitingSwBuild: buildIdentifierSchema.nullable(),
  }).strict(),
])

export type AlphaDiagnosticSignal = z.infer<typeof alphaDiagnosticSignalSchema>

export const createKabandaSchema = z.object({
  name: z.string().trim().min(1).max(80),
  avatar: z.enum(['🐗', '🚲', '🌲', '⚡', '🌙', '🔥']).default('🐗'),
})

export const updateKabandaSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    coverImage: z
      .string()
      .max(420_000)
      .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/)
      .optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.coverImage !== undefined)

export const transferKabandaLeadershipSchema = z.object({
  memberId: z.uuid(),
}).strict()

export const createInviteSchema = z.object({
  expiresInHours: z.coerce.number().int().min(1).max(168).default(24),
})

export const previewInviteSchema = z.union([
  z.object({ token: z.string().min(32).max(256) }),
  z.object({ continuation: z.string().min(32).max(256) }),
  z.object({ pending: z.literal(true) }),
])

export const acceptInviteContinuationSchema = z.union([
  z.object({
    continuation: z.string().min(32).max(256),
  }).strict(),
  z.object({
    continuation: z.string().min(32).max(256),
    username: usernameSchema,
    password: passwordSchema,
  }).strict(),
])

export const createPointCollectionSchema = z.object({
  name: z.string().trim().min(1).max(100),
})

export const pointListQuerySchema = z.object({
  collection: z.uuid(),
  bbox: z.string().max(100),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

export const recordPointVisitSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
})

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    errorId: z.uuid().optional(),
    operationRef: operationReferenceSchema.optional(),
  }),
})

export type User = z.infer<typeof userSchema>
export type RequestMagicLink = z.infer<typeof requestMagicLinkSchema>
export type UpdateProfile = z.infer<typeof updateProfileSchema>
export type CreateKabanda = z.infer<typeof createKabandaSchema>
export type UpdateKabanda = z.infer<typeof updateKabandaSchema>
