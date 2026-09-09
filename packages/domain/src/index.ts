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
