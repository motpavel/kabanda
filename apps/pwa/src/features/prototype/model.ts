export type PrototypeRole = 'organizer' | 'participant'

export type PrototypeScreenId =
  | 'entry'
  | 'invite'
  | 'auth'
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
  | 'map'
  | 'profile'

export type DeliveryState = 'local' | 'sending' | 'accepted' | 'needs_action'

export interface PrototypeScreen {
  id: PrototypeScreenId
  title: string
  primaryLabel: string
  participantPrimaryLabel?: string
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
  auth: { id: 'auth', title: 'Войти в КАБАНДУ', primaryLabel: 'Отправить ссылку для входа' },
  'auth-return': {
    id: 'auth-return',
    title: 'Приглашение сохранилось',
    primaryLabel: 'Вступить в Кабанду',
  },
  install: { id: 'install', title: 'Режим поездки', primaryLabel: 'Продолжить' },
  home: {
    id: 'home',
    title: 'Доброе утро, Павел',
    primaryLabel: 'Создать Кабанду',
    participantPrimaryLabel: 'Вернуться в рейд',
  },
  kabanda: {
    id: 'kabanda',
    title: 'Ижевские кабаны',
    primaryLabel: 'Создать рейд',
    participantPrimaryLabel: 'Открыть рейд',
  },
  'raid-setup': { id: 'raid-setup', title: 'Новый рейд', primaryLabel: 'Создать lobby' },
  lobby: {
    id: 'lobby',
    title: 'Вечерний рейд',
    primaryLabel: 'Проверить готовность',
    participantPrimaryLabel: 'Открыть активный рейд',
  },
  readiness: { id: 'readiness', title: 'Телефон готов', primaryLabel: 'Начать рейд' },
  active: { id: 'active', title: 'Вечерний рейд', primaryLabel: 'Закрыть точку' },
  'gps-recovery': {
    id: 'gps-recovery',
    title: 'Маршрут приостановлен',
    primaryLabel: 'Возобновить запись',
  },
  checkin: { id: 'checkin', title: 'Кто сейчас здесь?', primaryLabel: 'Подтвердить участников' },
  photo: { id: 'photo', title: 'Фото точки', primaryLabel: 'Добавить к рейду' },
  offline: {
    id: 'offline',
    title: 'Без сети, но всё сохранено',
    primaryLabel: 'Повторить отправку',
    participantPrimaryLabel: 'Открыть результат',
  },
  finish: { id: 'finish', title: 'Завершить рейд?', primaryLabel: 'Завершить рейд' },
  result: {
    id: 'result',
    title: 'Рейд завершён',
    primaryLabel: 'Запланировать следующий',
    participantPrimaryLabel: 'Открыть историю',
  },
  history: { id: 'history', title: 'История рейдов', primaryLabel: 'Открыть последний рейд' },
  map: { id: 'map', title: 'Карта точек', primaryLabel: 'Открыть ближайшую точку' },
  profile: { id: 'profile', title: 'Профиль', primaryLabel: 'На главную' },
}

export const flows: Record<PrototypeRole, PrototypeScreenId[]> = {
  organizer: [
    'entry',
    'auth',
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
    'map',
    'profile',
  ],
  participant: [
    'entry',
    'invite',
    'auth',
    'auth-return',
    'install',
    'lobby',
    'active',
    'checkin',
    'photo',
    'offline',
    'result',
    'history',
    'home',
    'kabanda',
    'map',
    'profile',
  ],
}

const primaryTargets: Record<PrototypeRole, Partial<Record<PrototypeScreenId, PrototypeScreenId>>> = {
  organizer: {
    entry: 'auth',
    auth: 'home',
    home: 'kabanda',
    kabanda: 'raid-setup',
    'raid-setup': 'lobby',
    lobby: 'readiness',
    readiness: 'active',
    active: 'gps-recovery',
    'gps-recovery': 'checkin',
    checkin: 'photo',
    photo: 'offline',
    offline: 'finish',
    finish: 'result',
    result: 'history',
    history: 'result',
    map: 'checkin',
    profile: 'home',
  },
  participant: {
    entry: 'invite',
    invite: 'auth',
    auth: 'auth-return',
    'auth-return': 'install',
    install: 'lobby',
    lobby: 'active',
    active: 'checkin',
    checkin: 'photo',
    photo: 'offline',
    offline: 'result',
    result: 'history',
    history: 'result',
    home: 'lobby',
    kabanda: 'lobby',
    map: 'checkin',
    profile: 'home',
  },
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

export function getPrimaryTarget(
  role: PrototypeRole,
  screen: PrototypeScreenId,
): PrototypeScreenId {
  return primaryTargets[role][screen] ?? screen
}

export function getPrimaryLabel(role: PrototypeRole, screen: PrototypeScreenId): string {
  const definition = screens[screen]
  return role === 'participant' && definition.participantPrimaryLabel
    ? definition.participantPrimaryLabel
    : definition.primaryLabel
}
