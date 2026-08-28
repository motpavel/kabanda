const base = import.meta.env.BASE_URL.endsWith('/')
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`

export function appPath(path = ''): string {
  return `${base}${path.replace(/^\/+/, '')}`
}

export function appUrl(path = ''): string {
  return new URL(appPath(path), window.location.origin).toString()
}
