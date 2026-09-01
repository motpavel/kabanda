import { describe, expect, it } from 'vitest'
import type { DraftRaidTemplatePoint, RaidTemplateDraft } from '../types'
import { raidTemplateDraftErrors, raidTemplateDraftReducer } from './reducer'

function draft(points: DraftRaidTemplatePoint[] = []): RaidTemplateDraft {
  return {
    schemaVersion: 2,
    clientDraftId: 'draft-1',
    identityId: 'identity-1',
    kabandaId: 'kabanda-1',
    scope: 'kabanda',
    title: 'Маршрут',
    coverImage: 'data:image/jpeg;base64,cover',
    points,
    selectedPointId: null,
    idempotencyKey: 'operation-1',
    updatedAt: '2026-09-01T10:00:00.000Z',
  }
}

function point(id: string, name = id): DraftRaidTemplatePoint {
  return {
    clientId: id,
    name,
    address: `Адрес ${id}`,
    comment: '',
    latitude: 56.85,
    longitude: 53.2,
    geocodeStatus: 'ready',
    geocodeRequestId: null,
    labelsConfirmed: true,
  }
}

describe('raid template editor reducer', () => {
  it('changes route access without touching the route content', () => {
    const initial = draft([point('a'), point('b')])
    const updated = raidTemplateDraftReducer(initial, { type: 'set-scope', scope: 'all_authenticated' })

    expect(updated).toMatchObject({ scope: 'all_authenticated', title: initial.title, points: initial.points })
  })

  it('reorders points both by drag target and accessible step buttons', () => {
    const initial = draft([point('a'), point('b'), point('c')])
    const dragged = raidTemplateDraftReducer(initial, { type: 'reorder-point', activeId: 'a', overId: 'c' })
    expect(dragged.points.map(({ clientId }) => clientId)).toEqual(['b', 'c', 'a'])

    const moved = raidTemplateDraftReducer(dragged, { type: 'move-point', pointId: 'a', direction: -1 })
    expect(moved.points.map(({ clientId }) => clientId)).toEqual(['b', 'a', 'c'])
  })

  it('ignores a stale reverse-geocode response and requires explicit label confirmation', () => {
    let current = draft([{ ...point('a', 'Точка 1'), labelsConfirmed: false }])
    current = raidTemplateDraftReducer(current, { type: 'start-geocode', pointId: 'a', requestId: 'new' })
    current = raidTemplateDraftReducer(current, {
      type: 'resolve-geocode', pointId: 'a', requestId: 'old', name: 'Старое', address: 'Старый адрес',
    })
    expect(current.points[0]?.name).toBe('Точка 1')

    current = raidTemplateDraftReducer(current, {
      type: 'resolve-geocode', pointId: 'a', requestId: 'new', name: 'Набережная', address: 'ул. Береговая, 1',
    })
    expect(current.points[0]).toMatchObject({
      name: 'Набережная',
      address: 'Адрес a',
      labelsConfirmed: false,
      geocodeStatus: 'ready',
    })
  })

  it('keeps manually edited and confirmed labels when reverse geocoding resolves late', () => {
    let current = draft([{
      ...point('a', 'Точка 1'),
      address: '',
      geocodeStatus: 'pending',
      labelsConfirmed: false,
    }])
    current = raidTemplateDraftReducer(current, { type: 'start-geocode', pointId: 'a', requestId: 'lookup' })
    current = raidTemplateDraftReducer(current, {
      type: 'update-point',
      pointId: 'a',
      patch: { name: 'Моя остановка', address: 'Мой адрес', labelsConfirmed: false },
    })
    current = raidTemplateDraftReducer(current, { type: 'confirm-point-labels', pointId: 'a' })
    expect(current.points[0]).toMatchObject({
      labelsConfirmed: true,
      geocodeStatus: 'ready',
      geocodeRequestId: null,
    })
    current = raidTemplateDraftReducer(current, {
      type: 'resolve-geocode',
      pointId: 'a',
      requestId: 'lookup',
      name: 'Ответ геокодера',
      address: 'Адрес геокодера',
    })

    expect(current.points[0]).toMatchObject({
      name: 'Моя остановка',
      address: 'Мой адрес',
      labelsConfirmed: true,
      geocodeStatus: 'ready',
      geocodeRequestId: null,
    })
  })

  it('does not mark a confirmed point as failed even if a matching geocode request remains', () => {
    const initial = draft([{
      ...point('a'),
      geocodeStatus: 'pending',
      geocodeRequestId: 'lookup',
    }])
    const current = raidTemplateDraftReducer(initial, {
      type: 'fail-geocode', pointId: 'a', requestId: 'lookup',
    })

    expect(current.points[0]).toMatchObject({
      labelsConfirmed: true,
      geocodeStatus: 'ready',
      geocodeRequestId: null,
    })
  })

  it('blocks save until two points have user-confirmed labels', () => {
    expect(raidTemplateDraftErrors(draft([point('a')]))).toContain('Добавьте хотя бы две точки.')
    expect(raidTemplateDraftErrors(draft([point('a'), { ...point('b'), labelsConfirmed: false }]))).toContain(
      'Подтвердите название и адрес каждой точки.',
    )
    expect(raidTemplateDraftErrors(draft([point('a'), point('b')]))).toEqual([])
  })
})
