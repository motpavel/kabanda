import { z } from 'zod'

export const userSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  displayName: z.string().min(1).max(80).nullable(),
  avatarUrl: z.url().nullable(),
})

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

export const createKabandaSchema = z.object({
  name: z.string().trim().min(1).max(80),
  avatar: z.enum(['🐗', '🚲', '🌲', '⚡', '🌙', '🔥']).default('🐗'),
})

export const updateKabandaSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => value.name !== undefined || value.archived !== undefined)

export const createInviteSchema = z.object({
  expiresInHours: z.coerce.number().int().min(1).max(168).default(24),
})

export const previewInviteSchema = z.union([
  z.object({ token: z.string().min(32).max(256) }),
  z.object({ continuation: z.string().min(32).max(256) }),
  z.object({ pending: z.literal(true) }),
])

export const acceptInviteContinuationSchema = z.object({
  continuation: z.string().min(32).max(256),
})

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
  }),
})

export type User = z.infer<typeof userSchema>
export type RequestMagicLink = z.infer<typeof requestMagicLinkSchema>
export type UpdateProfile = z.infer<typeof updateProfileSchema>
export type CreateKabanda = z.infer<typeof createKabandaSchema>
export type UpdateKabanda = z.infer<typeof updateKabandaSchema>
