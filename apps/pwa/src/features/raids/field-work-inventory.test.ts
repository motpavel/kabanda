import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { offlineDb } from '../offline/db'
import { activateIdentity, clearActiveIdentity } from '../offline/ledger'
import { fieldDb, type FieldOperation } from './field-outbox'
import { pendingFieldWork } from './FieldSyncOwner'

const row = (id: string, identityId: string, raidId: string, status: FieldOperation['status']): FieldOperation => ({
  operationId: id, identityId, kabandaId: 'team', raidId, pointId: 'point', kind: 'photo',
  payload: { kind: 'photo', body: 'Сохранённая фотография', sourceSha256: 'a'.repeat(64), contentType: 'image/jpeg', sizeBytes: 5 },
  blob: new Blob(['photo'], { type: 'image/jpeg' }), status, attempts: 2, createdAt: 1, nextAttemptAt: 5000,
  claimToken: status === 'sending' ? 'original-claim' : null, claimUntil: status === 'sending' ? 180000 : 0,
  lastError: status === 'retryable' ? 'TEMPORARY' : null,
})
beforeEach(async () => {
  await fieldDb.delete(); await fieldDb.open()
  await offlineDb.delete(); await offlineDb.open()
  await activateIdentity('user-a')
})
afterEach(async () => { await fieldDb.delete(); await offlineDb.delete() })

describe('application pending-work inventory', () => {
  it('finds pending work in every raid without returning another identity or accepted blobs', async () => {
    await fieldDb.operations.bulkAdd([
      row('first', 'user-a', 'raid-a', 'pending'), row('second', 'user-a', 'raid-b', 'retryable'),
      row('claimed', 'user-a', 'raid-a', 'sending'), row('done', 'user-a', 'raid-a', 'accepted'),
      row('denied', 'user-a', 'raid-a', 'rejected'), row('other-user', 'user-b', 'raid-a', 'pending'),
    ])
    const work = await pendingFieldWork('user-a')
    expect(work.map(item => item.operationId).sort()).toEqual(['claimed', 'first', 'second'])
    expect(new Set(work.map(item => item.raidId))).toEqual(new Set(['raid-a', 'raid-b']))
    for (const item of work) {
      expect(Object.keys(item).sort()).toEqual(['claimUntil', 'createdAt', 'kind', 'nextAttemptAt', 'operationId', 'raidId', 'status'])
    }
    expect(await fieldDb.operations.count()).toBe(6)
    expect(await (await fieldDb.operations.get('done'))!.blob!.text()).toBe('photo')
  })

  it('does not expose or reassign pending operations after identity switch', async () => {
    const original = row('first', 'user-a', 'raid-a', 'sending')
    await fieldDb.operations.add(original)
    await activateIdentity('user-b')
    expect(await pendingFieldWork('user-a')).toEqual([])
    expect(await pendingFieldWork('user-b')).toEqual([])
    expect(await fieldDb.operations.get('first')).toEqual(original)
    await activateIdentity('user-a')
    expect(await pendingFieldWork('user-a')).toEqual([expect.objectContaining({ operationId: 'first', claimUntil: 180000 })])
  })

  it('keeps every operation and actual photograph byte untouched when identity is cleared', async () => {
    const originals = ['pending', 'sending', 'retryable', 'accepted', 'rejected'].map((status, index) =>
      row(`photo-${index}`, 'user-a', 'raid-a', status as FieldOperation['status']))
    await fieldDb.operations.bulkAdd(originals)
    await clearActiveIdentity()
    expect(await pendingFieldWork('user-a')).toEqual([])
    expect(await fieldDb.operations.toArray()).toEqual(originals)
    for (const saved of await fieldDb.operations.toArray()) expect(await saved.blob!.text()).toBe('photo')
  })
})
