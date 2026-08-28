import type { CheckInClaim, CheckInFallback, RaidMediaPage } from './types'

export interface CheckInExtrasResult {
  claims?: CheckInClaim[]
  fallbacks?: CheckInFallback[]
  gallery?: RaidMediaPage
}

export async function loadCheckInExtras(loaders: {
  claims: () => Promise<CheckInClaim[]>
  fallbacks: () => Promise<CheckInFallback[]>
  gallery: () => Promise<RaidMediaPage>
}): Promise<CheckInExtrasResult> {
  const [claims, fallbacks, gallery] = await Promise.allSettled([
    loaders.claims(),
    loaders.fallbacks(),
    loaders.gallery(),
  ])
  return {
    ...(claims.status === 'fulfilled' ? { claims: claims.value } : {}),
    ...(fallbacks.status === 'fulfilled' ? { fallbacks: fallbacks.value } : {}),
    ...(gallery.status === 'fulfilled' ? { gallery: gallery.value } : {}),
  }
}
