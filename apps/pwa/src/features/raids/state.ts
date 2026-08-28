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

export type RaidPrimaryAction =
  | { kind: 'navigate'; label: string }
  | { kind: 'command'; command: RaidAllowedAction; label: string }
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
      lobby: 'Открыть lobby',
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
  if (context.viewerParticipantState === 'accepted' && allowed.has('ready')) {
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
  if (allowed.has('open-lobby')) return { kind: 'command', command: 'open-lobby', label: 'Открыть lobby' }
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

export function isStaleConflict(status: number, code: string): boolean {
  return (
    status === 409 &&
    (code === 'RAID_VERSION_CONFLICT' || code === 'VERSION_CONFLICT' || code === 'STALE_VERSION')
  )
}

function coordinateStatus(facts: LocalReadinessFacts, now: number): ReadinessStatus {
  if (facts.locationPermission === 'unsupported' || facts.locationPermission === 'denied') return 'fail'
  if (facts.locationPermission !== 'granted' || !facts.coordinateMeasuredAt) return 'unknown'
  return now - Date.parse(facts.coordinateMeasuredAt) <= 30_000 ? 'pass' : 'fail'
}

export function buildReadinessRows(
  facts: LocalReadinessFacts,
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
          : 'В браузере можно участвовать; сервер решит, допустим ли старт навигатора',
      status: facts.appMode === 'standalone' ? 'pass' : 'warn',
    },
    {
      id: 'location',
      label: 'Геолокация',
      detail:
        coordinate === 'pass'
          ? `Координата свежая${facts.accuracyM === null ? '' : `, точность ${Math.round(facts.accuracyM)} м`}`
          : facts.locationPermission === 'denied'
            ? 'Доступ запрещён — разрешите геолокацию в настройках'
            : facts.locationPermission === 'unsupported'
              ? 'Геолокация недоступна на этом устройстве'
              : facts.coordinateMeasuredAt
                ? 'Координата устарела — получите новую перед стартом'
                : 'Нужна первая свежая координата',
      status: coordinate,
    },
    {
      id: 'indexed-db',
      label: 'Локальное сохранение',
      detail: facts.indexedDbWritable
        ? 'Identity-bound очередь доступна для записи'
        : 'Хранилище недоступно — маршрут может потеряться',
      status: facts.indexedDbWritable ? 'pass' : 'fail',
    },
    {
      id: 'storage',
      label: 'Свободное место',
      detail: facts.storageAvailable === true
        ? 'Измеренного места достаточно для alpha-рейда'
        : facts.storageAvailable === false
          ? 'Измерение показало недостаток места или ошибку хранилища'
          : 'Браузер не поддерживает оценку свободного места',
      status: facts.storageAvailable === true ? 'pass' : facts.storageAvailable === false ? 'fail' : 'unknown',
    },
    {
      id: 'network',
      label: 'Связь с сервером',
      detail: facts.online ? 'Старт можно подтвердить каноническим receipt' : 'Офлайн-старт в VP запрещён',
      status: facts.online ? 'pass' : 'fail',
    },
    {
      id: 'wake-lock',
      label: 'Экран во время записи',
      detail: facts.wakeLockSupported
        ? 'Wake Lock доступен, но не обещает фоновый GPS'
        : 'Wake Lock недоступен — экран нельзя считать защищённым от сна',
      status: 'warn',
    },
    {
      id: 'service-worker',
      label: 'Версия приложения',
      detail: facts.serviceWorkerControlled
        ? 'App shell контролируется service worker'
        : 'Контроль service worker не подтверждён; сервер проверит совместимость',
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
