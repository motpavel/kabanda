export type AppSection = 'home' | 'map' | 'raids' | 'kabanda'

const appSections = new Set<AppSection>(['home', 'map', 'raids', 'kabanda'])

export function parseAppSection(search: string): AppSection {
  const value = new URLSearchParams(search).get('tab')
  return value && appSections.has(value as AppSection) ? value as AppSection : 'home'
}

export function appSectionSearch(
  search: string,
  section: AppSection,
  kabandaId: string | null,
): string {
  const params = new URLSearchParams(search)
  params.delete('raid')
  params.delete('createRaid')
  if (section === 'home') params.delete('tab')
  else params.set('tab', section)
  if (kabandaId) params.set('kabanda', kabandaId)
  else params.delete('kabanda')
  const query = params.toString()
  return query ? `?${query}` : ''
}
