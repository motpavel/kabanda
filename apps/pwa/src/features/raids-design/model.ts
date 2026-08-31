export type RaidsDesignScreen = 'hub' | 'preview' | 'participants' | 'scheduled'
export type RaidsDesignVariant = 'active' | 'idle' | 'loading' | 'catalog-error' | 'empty'

export const raidsDesignScreens: RaidsDesignScreen[] = ['hub', 'preview', 'participants', 'scheduled']
export const raidsDesignVariants: RaidsDesignVariant[] = ['active', 'idle', 'loading', 'catalog-error', 'empty']

export function parseRaidsDesignScreen(value: string | null): RaidsDesignScreen {
  return raidsDesignScreens.includes(value as RaidsDesignScreen) ? value as RaidsDesignScreen : 'hub'
}

export function parseRaidsDesignVariant(value: string | null): RaidsDesignVariant {
  return raidsDesignVariants.includes(value as RaidsDesignVariant) ? value as RaidsDesignVariant : 'active'
}

export interface RouteCardData {
  id: string
  title: string
  description: string
  distance: string
  points: number
  imagePosition: string
}

export const routeCards: RouteCardData[] = [
  { id: 'north', title: 'Северное кольцо', description: 'По северу города с видами на пруды и набережные', distance: '24,6 км', points: 15, imagePosition: '50% 38%' },
  { id: 'center', title: 'Центр Ижевска', description: 'Знакомые улицы, тихие скверы и центр города', distance: '18,2 км', points: 12, imagePosition: '38% 48%' },
  { id: 'lenina', title: 'По Ленина', description: 'Вечерний маршрут по длинному городскому проспекту', distance: '12,1 км', points: 8, imagePosition: '78% 42%' },
]

export const participants = [
  { id: 'pavel', name: 'Павел', role: 'Вожак', initial: 'П' },
  { id: 'motor', name: 'мотор', role: 'Участник', initial: 'М' },
  { id: 'anna', name: 'Аня', role: 'Участник', initial: 'А' },
  { id: 'max', name: 'Макс', role: 'Участник', initial: 'М' },
]
