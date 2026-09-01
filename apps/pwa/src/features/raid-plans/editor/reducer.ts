import {
  RAID_TEMPLATE_MAX_POINTS,
  RAID_TEMPLATE_MIN_POINTS,
  type DraftRaidTemplatePoint,
  type RaidTemplateDraft,
} from '../types'

export type RaidTemplateDraftAction =
  | { type: 'set-title'; title: string }
  | { type: 'set-cover'; coverImage: string | null }
  | { type: 'add-point'; point: DraftRaidTemplatePoint }
  | { type: 'select-point'; pointId: string | null }
  | { type: 'update-point'; pointId: string; patch: Partial<Pick<DraftRaidTemplatePoint, 'name' | 'address' | 'comment' | 'geocodeStatus' | 'geocodeRequestId' | 'labelsConfirmed'>> }
  | { type: 'confirm-point-labels'; pointId: string }
  | { type: 'start-geocode'; pointId: string; requestId: string }
  | { type: 'resolve-geocode'; pointId: string; requestId: string; name: string; address: string }
  | { type: 'fail-geocode'; pointId: string; requestId: string }
  | { type: 'move-point'; pointId: string; direction: -1 | 1 }
  | { type: 'reorder-point'; activeId: string; overId: string }
  | { type: 'delete-point'; pointId: string }
  | { type: 'replace'; draft: RaidTemplateDraft }

export function raidTemplateDraftReducer(draft: RaidTemplateDraft, action: RaidTemplateDraftAction): RaidTemplateDraft {
  const updatedAt = new Date().toISOString()
  switch (action.type) {
    case 'set-title':
      return { ...draft, title: action.title, updatedAt }
    case 'set-cover':
      return { ...draft, coverImage: action.coverImage, updatedAt }
    case 'add-point':
      if (draft.points.length >= RAID_TEMPLATE_MAX_POINTS) return draft
      return {
        ...draft,
        points: [...draft.points, action.point],
        selectedPointId: action.point.clientId,
        updatedAt,
      }
    case 'select-point':
      return { ...draft, selectedPointId: action.pointId }
    case 'update-point':
      return {
        ...draft,
        points: draft.points.map((point) => point.clientId === action.pointId ? { ...point, ...action.patch } : point),
        updatedAt,
      }
    case 'confirm-point-labels':
      return {
        ...draft,
        points: draft.points.map((point) => point.clientId === action.pointId
          ? { ...point, labelsConfirmed: true, geocodeStatus: 'ready', geocodeRequestId: null }
          : point),
        updatedAt,
      }
    case 'start-geocode':
      return {
        ...draft,
        points: draft.points.map((point) => point.clientId === action.pointId
          ? { ...point, geocodeStatus: 'pending', geocodeRequestId: action.requestId }
          : point),
        updatedAt,
      }
    case 'resolve-geocode':
      return {
        ...draft,
        points: draft.points.map((point) => {
          if (point.clientId !== action.pointId || point.geocodeRequestId !== action.requestId) return point
          if (point.labelsConfirmed) {
            return { ...point, geocodeStatus: 'ready', geocodeRequestId: null }
          }
          return {
            ...point,
            name: isFallbackPointName(point.name) && action.name ? action.name : point.name,
            address: point.address.trim() || action.address,
            geocodeStatus: 'ready',
            geocodeRequestId: null,
          }
        }),
        updatedAt,
      }
    case 'fail-geocode':
      return {
        ...draft,
        points: draft.points.map((point) => {
          if (point.clientId !== action.pointId || point.geocodeRequestId !== action.requestId) return point
          if (point.labelsConfirmed) return { ...point, geocodeStatus: 'ready', geocodeRequestId: null }
          return { ...point, geocodeStatus: 'failed', geocodeRequestId: null }
        }),
        updatedAt,
      }
    case 'move-point': {
      const from = draft.points.findIndex((point) => point.clientId === action.pointId)
      if (from < 0) return draft
      const to = from + action.direction
      if (to < 0 || to >= draft.points.length) return draft
      return { ...draft, points: moveItem(draft.points, from, to), updatedAt }
    }
    case 'reorder-point': {
      const from = draft.points.findIndex((point) => point.clientId === action.activeId)
      const to = draft.points.findIndex((point) => point.clientId === action.overId)
      if (from < 0 || to < 0 || from === to) return draft
      return { ...draft, points: moveItem(draft.points, from, to), updatedAt }
    }
    case 'delete-point': {
      const points = draft.points.filter((point) => point.clientId !== action.pointId)
      return {
        ...draft,
        points,
        selectedPointId: draft.selectedPointId === action.pointId ? null : draft.selectedPointId,
        updatedAt,
      }
    }
    case 'replace':
      return action.draft
  }
}

export function raidTemplateDraftErrors(draft: RaidTemplateDraft): string[] {
  const errors: string[] = []
  if (!draft.title.trim()) errors.push('Добавьте название маршрута.')
  if (!draft.coverImage) errors.push('Добавьте обложку маршрута.')
  if (draft.points.length < RAID_TEMPLATE_MIN_POINTS) errors.push('Добавьте хотя бы две точки.')
  if (draft.points.length > RAID_TEMPLATE_MAX_POINTS) errors.push(`Можно добавить не больше ${RAID_TEMPLATE_MAX_POINTS} точек.`)
  if (draft.points.some((point) => !point.name.trim() || !point.address.trim())) errors.push('Проверьте название и адрес каждой точки.')
  if (draft.points.some((point) => !point.labelsConfirmed)) errors.push('Подтвердите название и адрес каждой точки.')
  return errors
}

function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items]
  const [item] = next.splice(from, 1)
  if (item === undefined) return next
  next.splice(to, 0, item)
  return next
}

function isFallbackPointName(value: string): boolean {
  return /^Точка \d+$/.test(value.trim())
}
