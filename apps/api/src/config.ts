import { buildIdentifierSchema } from '@kabanda/contracts'
import { z } from 'zod'

const localMediaCapabilitySecret = 'kabanda-media-capability-local-only-change-me'
const booleanFlagSchema = z.enum(['true', 'false']).default('false').transform((value) => value === 'true')

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_BUILD_ID: buildIdentifierSchema.default('dev'),
  ALPHA_DIAGNOSTICS_ENABLED: booleanFlagSchema,
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  APP_ORIGIN: z.url().default('http://localhost:5173'),
  APP_BASE_PATH: z.string().regex(/^\/([^?#]*\/)?$/).default('/'),
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgresql://kabanda:kabanda@127.0.0.1:54329/kabanda'),
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(1025),
  SMTP_FROM: z.email().default('kabanda@example.test'),
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().min(5).max(60).default(15),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  MEDIA_CAPABILITY_SECRET: z.string().min(32).default(localMediaCapabilitySecret),
})

export type ApiConfig = z.infer<typeof environmentSchema> & {
  cookieName: string
  secureCookies: boolean
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = environmentSchema.parse(environment)
  if (
    parsed.NODE_ENV === 'production' &&
    parsed.MEDIA_CAPABILITY_SECRET === localMediaCapabilitySecret
  ) {
    throw new Error('MEDIA_CAPABILITY_SECRET must be configured in production')
  }
  const secureCookies = parsed.NODE_ENV === 'production'
  return {
    ...parsed,
    APP_ORIGIN: new URL(parsed.APP_ORIGIN).origin,
    secureCookies,
    cookieName: secureCookies ? '__Host-kabanda_session' : 'kabanda_session',
  }
}
