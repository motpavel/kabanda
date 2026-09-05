import type {
  LocalReadinessFacts,
  RaidAllowedAction,
  RaidParticipantState,
  RaidProjection,
  RaidReadinessSummary,
  ReadinessReportInput,
  ReadinessRow,
  ReadinessStatus,
} from './types'
import { locationRecoveryMessage, type LocationIssue } from './platform'

export type RaidPrimaryAction =
  | { kind: 'navigate'; label: string }
  | { kind: 'command'; command: Exclude<RaidAllowedAction, 'finish' | 'leave' | 'settle-finalization'>; label: string }
  | { kind: 'readiness'; label: string }
  | { kind: 'refresh'; label: string }

export interface PrimaryActionContext {
  surface: 'home' | 'raid'
  online: boolean
  stale: boolean
  viewerIsNavigator?: boolean
  viewerParticipantState?: RaidParticipantState | null
  localReadinessReported?: boolean
}

export function selectPrimaryAction(
  raid: RaidProjection,
  context: PrimaryActionContext,
): RaidPrimaryAction | null {
  if (context.stale) return context.online ? { kind: 'refresh', label: 'Обновить данные' } : null

  if (context.surface === 'home') {
    const labels: Partial<Record<RaidProjection['state'], string>> = {
      draft: 'Продолжить настройку',
      planned: 'Открыть рейд',
      lobby: 'Открыть сбор',
      active: 'Вернуться в рейд',
      paused: 'Вернуться в рейд',
      finalizing: 'Проверить завершение',
      completed: 'Открыть итог',
    }
    const label = labels[raid.state]
    return label ? { kind: 'navigate', label } : null
  }

  const allowed = new Set(raid.allowedActions)
  if (allowed.has('accept')) return { kind: 'command', command: 'accept', label: 'Принять приглашение' }
  if (context.viewerIsNavigator && context.viewerParticipantState === 'accepted' && allowed.has('ready')) {
    return { kind: 'command', command: 'ready', label: 'Я готов' }
  }
  if (
    context.viewerIsNavigator &&
    context.viewerParticipantState === 'ready' &&
    !raid.navigatorReady &&
    !context.localReadinessReported &&
    context.online
  ) {
    return { kind: 'readiness', label: 'Проверить телефон' }
  }
  if (allowed.has('start') && context.online) return { kind: 'command', command: 'start', label: 'Начать рейд' }
  if (allowed.has('open-lobby')) return { kind: 'command', command: 'open-lobby', label: 'Открыть сбор' }
  if (allowed.has('pause') && context.online) return { kind: 'command', command: 'pause', label: 'Поставить на паузу' }
  if (allowed.has('resume') && context.online) return { kind: 'command', command: 'resume', label: 'Продолжить рейд' }
  return null
}

export function isReadinessReportCurrent(
  report: RaidReadinessSummary | null,
  raidVersion: number,
  now = Date.now(),
): boolean {
  if (!report || report.raidVersion !== raidVersion || report.blockers.length > 0) return false
  const expiresAt = Date.parse(report.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt > now
}

export function selectCurrentRaid(raids: RaidProjection[]): RaidProjection | null {
  return raids.find(({ state }) => state === 'active' || state === 'paused' || state === 'finalizing') ?? null
}

export function canShareRaidInvite(state: RaidProjection['state']): boolean {
  return state === 'lobby'
}

export function isStaleConflict(status: number, code: string): boolean {
  return (
    status === 409 &&
    (code === 'RAID_VERSION_CONFLICT' || code === 'VERSION_CONFLICT' || code === 'STALE_VERSION')
  )
}

function coordinateStatus(facts: LocalReadinessFacts, now: number): ReadinessStatus {
  if (facts.locationPermission === 'unsupported' || facts.locationPermission === 'denied') return 'fail'
  if (facts.locationPermission !== 'granted' || !facts.coordinateMeasuredAt) return 'unknown'
  const age = now - Date.parse(facts.coordinateMeasuredAt)
  return Number.isFinite(age) && age >= -5_000 && age <= 30_000 &&
    facts.accuracyM !== null && Number.isFinite(facts.accuracyM) && facts.accuracyM >= 0 && facts.accuracyM <= 100
    ? 'pass' : 'fail'
}

export function buildReadinessRows(
  facts: LocalReadinessFacts & { locationIssue?: LocationIssue | null },
  now = Date.now(),
): ReadinessRow[] {
  const coordinate = coordinateStatus(facts, now)
  return [
    {
      id: 'mode',
      label: 'Режим приложения',
      detail:
        facts.appMode === 'standalone'
          ? 'Установленная КАБАНДА открыта отдельно'
          : 'Кабанда открыта в браузере',
      status: facts.appMode === 'standalone' ? 'pass' : 'warn',
    },
    {
      id: 'location',
      label: 'Геолокация',
      detail:
        coordinate === 'pass'
          ? `Координата свежая${facts.accuracyM === null ? '' : `, точность ${Math.round(facts.accuracyM)} м`}`
          : facts.locationIssue
            ? locationRecoveryMessage(facts.locationIssue)
          : facts.locationPermission === 'denied'
            ? locationRecoveryMessage('denied')
            : facts.locationPermission === 'unsupported'
              ? locationRecoveryMessage('unsupported')
              : facts.coordinateMeasuredAt
                ? locationRecoveryMessage(facts.accuracyM === null || facts.accuracyM > 100 ? 'inaccurate' : 'stale')
                : 'Нажмите «Обновить геолокацию», чтобы телефон определил ваше местоположение',
      status: coordinate,
    },
    {
      id: 'indexed-db',
      label: 'Локальное сохранение',
      detail: facts.indexedDbWritable
        ? 'Маршрут можно сохранять на телефоне'
        : 'Хранилище недоступно — маршрут может потеряться',
      status: facts.indexedDbWritable ? 'pass' : 'fail',
    },
    {
      id: 'storage',
      label: 'Свободное место',
      detail: facts.storageAvailable === true
        ? 'На телефоне достаточно места для записи маршрута'
        : facts.storageAvailable === false
          ? 'Измерение показало недостаток места или ошибку хранилища'
          : 'Браузер не поддерживает оценку свободного места',
      status: facts.storageAvailable === true ? 'pass' : facts.storageAvailable === false ? 'fail' : 'unknown',
    },
    {
      id: 'network',
      label: 'Связь с сервером',
      detail: facts.online ? 'Есть соединение для старта рейда' : 'Для старта подключитесь к интернету',
      status: facts.online ? 'pass' : 'fail',
    },
    {
      id: 'wake-lock',
      label: 'Экран во время записи',
      detail: facts.wakeLockSupported
        ? 'Не закрывайте приложение: запись в фоне может прерваться'
        : 'Не блокируйте экран во время записи маршрута',
      status: 'warn',
    },
    {
      id: 'service-worker',
      label: 'Версия приложения',
      detail: facts.serviceWorkerControlled
        ? 'Приложение готово к работе без сети'
        : 'Перезагрузите приложение с подключённым интернетом',
      status: facts.serviceWorkerControlled ? 'pass' : 'unknown',
    },
  ]
}

export function buildReadinessReport(
  expectedVersion: number,
  facts: LocalReadinessFacts,
): ReadinessReportInput {
  return {
    expectedVersion,
    appMode: facts.appMode,
    locationPermission: facts.locationPermission,
    coordinateMeasuredAt: facts.coordinateMeasuredAt,
    accuracyM: facts.accuracyM,
    indexedDbWritable: facts.indexedDbWritable,
    storageAvailable: facts.storageAvailable,
    online: facts.online,
    measuredAt: facts.measuredAt,
  }
}
