export type PrototypeRole = 'organizer' | 'participant'

export type PrototypeScreenId =
  | 'entry'
  | 'invite'
  | 'auth-return'
  | 'install'
  | 'home'
  | 'kabanda'
  | 'raid-setup'
  | 'lobby'
  | 'readiness'
  | 'active'
  | 'gps-recovery'
  | 'checkin'
  | 'photo'
  | 'offline'
  | 'finish'
  | 'result'
  | 'history'

export type DeliveryState = 'local' | 'sending' | 'accepted' | 'needs_action'

export interface PrototypeScreen {
  id: PrototypeScreenId
  title: string
  primaryLabel: string
}

export const deliveryStateCopy: Record<DeliveryState, string> = {
  local: 'Сохранено на телефоне',
  sending: 'Отправляем',
  accepted: 'Принято Кабандой',
  needs_action: 'Нужно действие',
}

export const screens: Record<PrototypeScreenId, PrototypeScreen> = {
  entry: { id: 'entry', title: 'Проверка сценария', primaryLabel: 'Начать сценарий' },
  invite: { id: 'invite', title: 'Вас ждёт Кабанда', primaryLabel: 'Продолжить по почте' },
  'auth-return': {
    id: 'auth-return',
    title: 'Приглашение сохранилось',
    primaryLabel: 'Вступить в Кабанду',
  },
  install: { id: 'install', title: 'Режим поездки', primaryLabel: 'Продолжить' },
  home: { id: 'home', title: 'Доброе утро, Павел', primaryLabel: 'Создать Кабанду' },
  kabanda: { id: 'kabanda', title: 'Ижевские кабаны', primaryLabel: 'Создать рейд' },
  'raid-setup': { id: 'raid-setup', title: 'Новый рейд', primaryLabel: 'Создать lobby' },
  lobby: { id: 'lobby', title: 'Вечерний рейд', primaryLabel: 'Проверить готовность' },
  readiness: { id: 'readiness', title: 'Телефон готов', primaryLabel: 'Начать рейд' },
  active: { id: 'active', title: 'Вечерний рейд', primaryLabel: 'Закрыть точку' },
  'gps-recovery': {
    id: 'gps-recovery',
    title: 'Маршрут приостановлен',
    primaryLabel: 'Возобновить запись',
  },
  checkin: { id: 'checkin', title: 'Кто сейчас здесь?', primaryLabel: 'Подтвердить участников' },
  photo: { id: 'photo', title: 'Фото точки', primaryLabel: 'Добавить к рейду' },
  offline: { id: 'offline', title: 'Без сети, но всё сохранено', primaryLabel: 'Повторить отправку' },
  finish: { id: 'finish', title: 'Завершить рейд?', primaryLabel: 'Завершить рейд' },
  result: { id: 'result', title: 'Рейд завершён', primaryLabel: 'Запланировать следующий' },
  history: { id: 'history', title: 'История рейдов', primaryLabel: 'Открыть последний рейд' },
}

export const flows: Record<PrototypeRole, PrototypeScreenId[]> = {
  organizer: [
    'entry',
    'home',
    'kabanda',
    'raid-setup',
    'lobby',
    'readiness',
    'active',
    'gps-recovery',
    'checkin',
    'photo',
    'offline',
    'finish',
    'result',
    'history',
  ],
  participant: [
    'entry',
    'invite',
    'auth-return',
    'install',
    'lobby',
    'active',
    'checkin',
    'photo',
    'offline',
    'finish',
    'result',
    'history',
  ],
}

export function isPrototypeRole(value: string | null): value is PrototypeRole {
  return value === 'organizer' || value === 'participant'
}

export function isScreenInFlow(
  role: PrototypeRole,
  value: string | null,
): value is PrototypeScreenId {
  return value !== null && flows[role].includes(value as PrototypeScreenId)
}

export function getAdjacentScreen(
  role: PrototypeRole,
  screen: PrototypeScreenId,
  direction: -1 | 1,
): PrototypeScreenId {
  const flow = flows[role]
  const currentIndex = Math.max(0, flow.indexOf(screen))
  const nextIndex = Math.min(flow.length - 1, Math.max(0, currentIndex + direction))
  return flow[nextIndex]!
}
