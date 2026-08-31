export type RaidsDesignScreen = 'hub' | 'preview' | 'schedule' | 'participants' | 'scheduled'
export type RaidsDesignVariant =
  | 'active'
  | 'idle'
  | 'loading'
  | 'catalog-error'
  | 'empty'
  | 'upcoming-empty'
  | 'upcoming-cases'
  | 'offline'
  | 'fallback'
  | 'archived'
  | 'partial-error'
export type ParticipantDesignState = 'default' | 'long' | 'error'

export interface ParticipantData {
  id: string
  name: string
  role: string
  initial: string
  disabled?: boolean
}

export const raidsDesignScreens: RaidsDesignScreen[] = ['hub', 'preview', 'schedule', 'participants', 'scheduled']
export const raidsDesignVariants: RaidsDesignVariant[] = [
  'active',
  'idle',
  'loading',
  'catalog-error',
  'empty',
  'upcoming-empty',
  'upcoming-cases',
  'offline',
  'fallback',
  'archived',
  'partial-error',
]
export const participantDesignStates: ParticipantDesignState[] = ['default', 'long', 'error']

export function parseRaidsDesignScreen(value: string | null): RaidsDesignScreen {
  return raidsDesignScreens.includes(value as RaidsDesignScreen) ? value as RaidsDesignScreen : 'hub'
}

export function parseRaidsDesignVariant(value: string | null): RaidsDesignVariant {
  return raidsDesignVariants.includes(value as RaidsDesignVariant) ? value as RaidsDesignVariant : 'active'
}

export function parseParticipantDesignState(value: string | null): ParticipantDesignState {
  return participantDesignStates.includes(value as ParticipantDesignState)
    ? value as ParticipantDesignState
    : 'default'
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

export const participants: ParticipantData[] = [
  { id: 'pavel', name: 'Павел', role: 'Вожак', initial: 'П' },
  { id: 'motor', name: 'мотор', role: 'Участник', initial: 'М' },
  { id: 'anna', name: 'Аня', role: 'Участник', initial: 'А' },
  { id: 'max', name: 'Макс', role: 'Участник', initial: 'М' },
  { id: 'lesha', name: 'Лёша', role: 'Участник', initial: 'Л' },
  { id: 'ivan', name: 'Иван', role: 'Недоступен', initial: 'И', disabled: true },
]

export const longParticipantList: ParticipantData[] = [
  ...participants,
  ...Array.from({ length: 14 }, (_, index) => ({
    id: `member-${index + 7}`,
    name: `Участник ${index + 7}`,
    role: 'Участник',
    initial: String(index + 7),
  })),
]
