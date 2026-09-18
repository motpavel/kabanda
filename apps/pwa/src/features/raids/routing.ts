export type RaidRoute =
  | { kind: 'home' }
  | { kind: 'template'; templateId: string; kabandaId: string }
  | { kind: 'create'; kabandaId: string }
  | { kind: 'create-template'; kabandaId: string }
  | { kind: 'raid'; raidId: string }
  | { kind: 'invalid' }

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseRaidRoute(search: string): RaidRoute {
  const params = new URLSearchParams(search)
  const routeTemplate = params.get('routeTemplate')
  if (routeTemplate) {
    const team = params.get('kabanda') ?? ''
    return uuidPattern.test(routeTemplate) && uuidPattern.test(team) ? { kind: 'template', templateId: routeTemplate, kabandaId: team } : { kind: 'invalid' }
  }
  const raidId = params.get('raid')
  const templateKabandaId = params.get('createRaidTemplate')
  const kabandaId = params.get('createRaid')
  if (raidId) return uuidPattern.test(raidId) ? { kind: 'raid', raidId } : { kind: 'invalid' }
  if (templateKabandaId) return uuidPattern.test(templateKabandaId) ? { kind: 'create-template', kabandaId: templateKabandaId } : { kind: 'invalid' }
  if (kabandaId) return uuidPattern.test(kabandaId) ? { kind: 'create', kabandaId } : { kind: 'invalid' }
  return { kind: 'home' }
}
