import { z } from 'zod'

export const historyScopeSchema = z.enum(['all', 'mine'])
export type HistoryScope = z.infer<typeof historyScopeSchema>
export const historyPageQuerySchema = z.object({
  scope: historyScopeSchema.default('all'),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  cursor: z.string().min(1).max(640).optional(),
})
export const historyMetricsSchema = z.object({
  durationSeconds: z.number().finite().nonnegative(),
  distanceMeters: z.number().finite().nonnegative(),
  uniquePoints: z.number().int().nonnegative(),
  photos: z.number().int().nonnegative(),
})
export const historyEntrySchema = z.object({
  raidId: z.uuid(), title: z.string(), completedAt: z.iso.datetime({ offset: true }),
  partial: z.boolean(), participated: z.boolean(),
  team: historyMetricsSchema, personal: historyMetricsSchema,
})
export const historyPageSchema = z.object({
  schemaVersion: z.literal(2), scope: historyScopeSchema,
  raids: z.array(historyEntrySchema).max(50), nextCursor: z.string().min(1).max(640).nullable(),
})
export type HistoryEntry = z.infer<typeof historyEntrySchema>
export type HistoryPage = z.infer<typeof historyPageSchema>

export const pointProgressQuerySchema = z.object({
  category: z.enum(['stores', 'attractions']), collection: z.uuid().optional(),
}).refine(value => value.category === 'stores' || Boolean(value.collection), {
  message: 'A collection is required for attractions', path: ['collection'],
})
export const pointProgressEntrySchema = z.object({
  pointId: z.uuid().nullable(), stableId: z.string().min(1).max(240),
  personalCount: z.number().int().nonnegative(), teamCount: z.number().int().nonnegative(),
})
export const pointProgressSchema = z.object({
  category: z.enum(['stores', 'attractions']), collectionId: z.uuid().nullable(),
  complete: z.boolean(), points: z.array(pointProgressEntrySchema).max(500),
})
export type PointProgress = z.infer<typeof pointProgressSchema>
export type PointProgressQuery = z.infer<typeof pointProgressQuerySchema>
