import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { offlineDb } from '../../offline/db'
import { activateIdentity } from '../../offline/ledger'
import { readRaidMapCache, saveRaidMapCache } from './map-cache'

beforeEach(async () => { await offlineDb.open() })
afterEach(async () => { await offlineDb.delete() })
it('does not expose another identity’s route cache after switching accounts', async () => {
  await activateIdentity('one')
  await saveRaidMapCache('one','raid',[],{segments:[],pointCount:0,truncated:false,updatedAt:null,serverAt:new Date().toISOString()})
  expect(await readRaidMapCache('one','raid')).not.toBeNull()
  await activateIdentity('two')
  expect(await readRaidMapCache('one','raid')).toBeNull()
  expect(await readRaidMapCache('two','raid')).toBeNull()
})

it('persists the authoritative completed revision alongside its complete geometry', async () => {
  await activateIdentity('one')
  await saveRaidMapCache('one', 'raid', [], { segments: [], pointCount: 0, truncated: false, updatedAt: null, serverAt: new Date().toISOString() }, 'revision-123')
  expect((await readRaidMapCache('one', 'raid'))?.snapshotRevision).toBe('revision-123')
})
