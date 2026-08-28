import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activateIdentity, clearActiveIdentity } from '../offline/ledger'
import { offlineDb } from '../offline/db'
import { readPointProjection, savePointProjection } from './cache'
import type { KabandaPoint } from './types'

const point: KabandaPoint = {
  id: 'point-1',
  stableId: 'water-tower',
  name: 'Старая водонапорная башня',
  latitude: 53.1959,
  longitude: 50.1002,
  verificationStatus: 'source_checked',
  visitedByMe: true,
  visitedByTeam: true,
}

describe('identity-bound point projection', () => {
  beforeEach(async () => {
    await offlineDb.delete()
    await offlineDb.open()
  })

  afterEach(async () => {
    await offlineDb.delete()
  })

  it('never exposes another identity, kabanda, or collection', async () => {
    await activateIdentity('user-a')
    await savePointProjection('user-a', 'kabanda-a', 'collection-a', [point])

    expect((await readPointProjection('user-a', 'kabanda-a', 'collection-a'))?.points).toEqual([point])
    expect(await readPointProjection('user-a', 'kabanda-b', 'collection-a')).toBeNull()
    expect(await readPointProjection('user-a', 'kabanda-a', 'collection-b')).toBeNull()

    await activateIdentity('user-b')
    expect(await readPointProjection('user-a', 'kabanda-a', 'collection-a')).toBeNull()
    expect(await readPointProjection('user-b', 'kabanda-a', 'collection-a')).toBeNull()

    await clearActiveIdentity()
    expect(await readPointProjection('user-a', 'kabanda-a', 'collection-a')).toBeNull()
  })
})
