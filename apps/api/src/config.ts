import { buildIdentifierSchema } from '@kabanda/contracts'
import { z } from 'zod'

const localMediaCapabilitySecret = 'kabanda-media-capability-local-only-change-me'
const booleanFlagSchema = z.enum(['true', 'false']).default('false').transform((value) => value === 'true')

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_BUILD_ID: buildIdentifierSchema.default('dev'),
  ALPHA_DIAGNOSTICS_ENABLED: booleanFlagSchema,
  ALPHA_ACCESS_MODE: z.enum(['disabled', 'enforced']).default('disabled'),
  ALPHA_ACCESS_SECRET: z.string().min(32).optional(),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  APP_ORIGIN: z.url().default('http://localhost:5173'),
  APP_BASE_PATH: z.string().regex(/^\/([^?#]*\/)?$/).default('/'),
  NOMINATIM_BASE_URL: z.url().default('https://nominatim.openstreetmap.org'),
  PWA_DIST_DIR: z.string().min(1).optional(),
  TRUST_PROXY_ADDRESS: z.string().min(1).optional(),
  EXPECTED_MIGRATION: z.string().regex(/^\d{4}_[a-z0-9_]+\.sql$/).default('0016_raid_departure_options.sql'),
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgresql://kabanda:kabanda@127.0.0.1:54329/kabanda'),
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(1025),
  SMTP_FROM: z.email().default('kabanda@example.test'),
  SMTP_SECURE: booleanFlagSchema,
  SMTP_REQUIRE_TLS: booleanFlagSchema,
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().min(5).max(60).default(15),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  MEDIA_CAPABILITY_SECRET: z.string().min(32).default(localMediaCapabilitySecret),
}).superRefine((value, context) => {
  if (Boolean(value.SMTP_USER) !== Boolean(value.SMTP_PASSWORD)) {
    context.addIssue({
      code: 'custom',
      path: ['SMTP_USER'],
      message: 'SMTP_USER and SMTP_PASSWORD must be configured together',
    })
  }
  if (value.SMTP_SECURE && value.SMTP_REQUIRE_TLS) {
    context.addIssue({
      code: 'custom',
      path: ['SMTP_REQUIRE_TLS'],
      message: 'Use SMTP_SECURE for implicit TLS or SMTP_REQUIRE_TLS for STARTTLS, not both',
    })
  }
  if (value.SMTP_USER && !value.SMTP_SECURE && !value.SMTP_REQUIRE_TLS) {
    context.addIssue({
      code: 'custom',
      path: ['SMTP_REQUIRE_TLS'],
      message: 'Authenticated SMTP requires implicit TLS or required STARTTLS',
    })
  }
  if (value.ALPHA_ACCESS_MODE === 'enforced' && !value.ALPHA_ACCESS_SECRET) {
    context.addIssue({
      code: 'custom',
      path: ['ALPHA_ACCESS_SECRET'],
      message: 'ALPHA_ACCESS_SECRET is required when closed-alpha access is enforced',
    })
  }
})

export type ApiConfig = z.infer<typeof environmentSchema> & {
  cookieName: string
  secureCookies: boolean
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = environmentSchema.parse(environment)
  const appOrigin = new URL(parsed.APP_ORIGIN)
  if (
    parsed.NODE_ENV === 'production' &&
    parsed.MEDIA_CAPABILITY_SECRET === localMediaCapabilitySecret
  ) {
    throw new Error('MEDIA_CAPABILITY_SECRET must be configured in production')
  }
  if (parsed.NODE_ENV === 'production' && parsed.ALPHA_ACCESS_MODE !== 'enforced') {
    throw new Error('ALPHA_ACCESS_MODE must be enforced in production')
  }
  const loopbackOrigin = ['localhost', '127.0.0.1', '::1'].includes(appOrigin.hostname)
  if (parsed.NODE_ENV === 'production' && appOrigin.protocol !== 'https:' && !loopbackOrigin) {
    throw new Error('APP_ORIGIN must use HTTPS outside loopback in production')
  }
  const secureCookies = parsed.NODE_ENV === 'production'
  return {
    ...parsed,
    APP_ORIGIN: appOrigin.origin,
    secureCookies,
    cookieName: secureCookies ? '__Host-kabanda_session' : 'kabanda_session',
  }
}
