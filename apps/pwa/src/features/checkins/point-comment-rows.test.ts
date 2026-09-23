import { describe, expect, it } from 'vitest'
import type { FieldOperation } from '../raids/field-outbox'
import type { PointMaterial } from './PointMaterialsPanel'
import { pointCommentRows } from './point-comment-rows'

const scope = { identityId: 'me', raidId: 'raid', pointId: 'point' }
const operation = (extra: Partial<FieldOperation> = {}): FieldOperation => ({
  operationId: 'op', ...scope, kabandaId: 'team', kind: 'comment', payload: { kind: 'comment', body: 'Отличная остановка!' },
  status: 'pending', attempts: 0, createdAt: 1000, nextAttemptAt: 0, claimToken: null, claimUntil: 0, lastError: null, ...extra,
})
const saved = (extra: Partial<PointMaterial> = {}): PointMaterial => ({ id: 'server', pointSnapshotId: 'point',
  authorUserId: 'me', authorName: 'Павел', kind: 'comment', body: 'Отличная остановка!', ready: true,
  width: null, height: null, createdAt: new Date(1000).toISOString(), ...extra })

describe('inline point comment rows', () => {
  it.each(['pending', 'sending', 'retryable', 'rejected'] as const)('retains actual text in %s, not a status-only placeholder', state => {
    expect(pointCommentRows([], [operation({ status: state })], scope)).toEqual([
      { id: 'local:op', body: 'Отличная остановка!', authorName: 'Вы', createdAt: 1000, state },
    ])
  })
  it('keeps an accepted comment visible before the list catches up', () => {
    expect(pointCommentRows([], [operation({ status: 'accepted', serverId: 'server' })], scope)[0]?.state).toBe('confirmed')
  })
  it('replaces a local row by server identity without duplicate text', () => {
    const rows = pointCommentRows([saved()], [operation({ status: 'accepted', serverId: 'server' })], scope)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'server', authorName: 'Павел', state: 'confirmed' })
  })
  it('keeps distinct comments with identical text', () => {
    expect(pointCommentRows([saved()], [operation({ operationId: 'second' })], scope)).toHaveLength(2)
  })
  it('uses the latest queue snapshot after the immediate enqueue result', () => {
    expect(pointCommentRows([], [operation(), operation({ status: 'accepted', serverId: 'server' })], scope)).toHaveLength(1)
    expect(pointCommentRows([], [operation(), operation({ status: 'accepted', serverId: 'server' })], scope)[0]?.state).toBe('confirmed')
  })
  it('never shows another account, raid or point local comment', () => {
    expect(pointCommentRows([], [operation({ identityId: 'other' }), operation({ raidId: 'other' }), operation({ pointId: 'other' })], scope)).toEqual([])
  })
  it('appends new text after older comments and does not mutate inputs', () => {
    const old = Object.freeze(saved({ id: 'old', createdAt: new Date(0).toISOString(), authorUserId: 'rider', authorName: 'Участник' }))
    const local = Object.freeze(operation())
    expect(pointCommentRows(Object.freeze([old]), Object.freeze([local]), scope).map(row => row.id)).toEqual(['old', 'local:op'])
    expect(local.status).toBe('pending')
  })
  it('does not turn a photo, unready material or a team operation into a comment', () => {
    expect(pointCommentRows([saved({ kind: 'photo' }), saved({ ready: false })], [operation({ kind: 'team' }),
      operation({ kind: 'photo' })], scope)).toEqual([])
  })
  it('preserves multiline and markup-looking text as literal text', () => {
    const body = '<img src=x onerror=alert(1)>\nЕщё строка'
    expect(pointCommentRows([], [operation({ payload: { kind: 'comment', body } })], scope)[0]?.body).toBe(body)
  })
})
