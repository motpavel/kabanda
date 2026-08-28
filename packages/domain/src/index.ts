export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function sanitizeReturnTo(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//')) return '/'
  try {
    const url = new URL(value, 'https://kabanda.invalid')
    if (url.origin !== 'https://kabanda.invalid') return '/'
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return '/'
  }
}

export const IZHEVSK_BOUNDS = {
  minLat: 56.7,
  minLon: 53,
  maxLat: 57,
  maxLon: 53.4,
} as const

export type GeographicBounds = {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
}

export function isBoundedIzhevskQuery(bounds: GeographicBounds): boolean {
  return (
    Number.isFinite(bounds.minLat) &&
    Number.isFinite(bounds.minLon) &&
    Number.isFinite(bounds.maxLat) &&
    Number.isFinite(bounds.maxLon) &&
    bounds.minLat >= IZHEVSK_BOUNDS.minLat &&
    bounds.minLon >= IZHEVSK_BOUNDS.minLon &&
    bounds.maxLat <= IZHEVSK_BOUNDS.maxLat &&
    bounds.maxLon <= IZHEVSK_BOUNDS.maxLon &&
    bounds.minLat < bounds.maxLat &&
    bounds.minLon < bounds.maxLon &&
    bounds.maxLat - bounds.minLat <= 0.2 &&
    bounds.maxLon - bounds.minLon <= 0.25
  )
}
