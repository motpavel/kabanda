import type { RecorderPhase, WakeLockPhase } from './types'

export const ROUTE_STALE_AFTER_MS = 15_000

export function isPersistedSampleFresh(
  lastPersistedSampleAt: string | null,
  now = Date.now(),
): boolean {
  if (!lastPersistedSampleAt) return false
  const capturedAt = Date.parse(lastPersistedSampleAt)
  return Number.isFinite(capturedAt) && capturedAt <= now + 5_000 && now - capturedAt < ROUTE_STALE_AFTER_MS
}

export function deriveRecorderPhase(input: {
  eligible: boolean
  paused: boolean
  visible: boolean
  ownsWriterLease: boolean
  watchActive: boolean
  lastPersistedSampleAt: string | null
  blocked: boolean
  failed: boolean
  recovering: boolean
  now?: number
}): RecorderPhase {
  if (!input.eligible) return 'ineligible'
  if (input.paused) return 'paused'
  if (input.blocked) return 'blocked'
  if (input.failed) return 'error'
  if (!input.visible || !input.ownsWriterLease) return 'standby'
  if (input.recovering) return 'recovering'
  if (!input.watchActive) return 'waiting'
  return isPersistedSampleFresh(input.lastPersistedSampleAt, input.now) ? 'fresh' : 'stale'
}

export type RecorderPrimaryAction = 'recover' | 'server' | null

export function selectActivePrimaryAction(
  phase: RecorderPhase,
  hasServerPrimary: boolean,
): RecorderPrimaryAction {
  if (phase === 'standby' || phase === 'stale' || phase === 'blocked' || phase === 'error') {
    return 'recover'
  }
  return hasServerPrimary ? 'server' : null
}

export function shouldDeferServiceWorkerUpdate(
  phase: RecorderPhase,
  unsyncedCheckInWork = 0,
): boolean {
  return unsyncedCheckInWork > 0 || phase === 'standby' || phase === 'recovering' || phase === 'waiting' || phase === 'fresh' || phase === 'stale'
}

export function routeStatusLabel(phase: RecorderPhase): string {
  return {
    ineligible: 'Маршрут пишет выбранный навигатор',
    standby: 'Запись в другой вкладке или приостановлена страницей',
    recovering: 'Восстанавливаем запись',
    waiting: 'Ждём первую координату',
    fresh: 'Маршрут записывается',
    stale: 'Свежей координаты нет',
    blocked: 'Геолокация заблокирована',
    error: 'Запись маршрута остановилась',
    paused: 'Маршрут на паузе',
  }[phase]
}

export function wakeLockLabel(phase: WakeLockPhase): string {
  return {
    unsupported: 'Wake Lock не поддерживается',
    requesting: 'Запрашиваем Wake Lock',
    held: 'Экран удерживается открытым',
    released: 'Wake Lock отпущен системой',
    failed: 'Wake Lock включить не удалось',
  }[phase]
}
