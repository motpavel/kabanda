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

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

export type User = z.infer<typeof userSchema>
export type RequestMagicLink = z.infer<typeof requestMagicLinkSchema>
export type UpdateProfile = z.infer<typeof updateProfileSchema>
