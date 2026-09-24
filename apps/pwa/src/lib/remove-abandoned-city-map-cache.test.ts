import { IDBFactory } from 'fake-indexeddb'
import { afterEach, expect, it, vi } from 'vitest'
import { removeAbandonedCityMapCache } from './remove-abandoned-city-map-cache'

afterEach(() => vi.unstubAllGlobals())

function open(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

it('removes only the abandoned public archive and preserves unrelated databases', async () => {
  const factory = new IDBFactory()
  vi.stubGlobal('indexedDB', factory)
  ;(await open(factory, 'kabanda-city-map')).close()
  ;(await open(factory, 'kabanda-private-recording')).close()
  removeAbandonedCityMapCache()
  await vi.waitFor(async () => {
    expect((await factory.databases()).map(db => db.name)).toEqual(['kabanda-private-recording'])
  })
})

it('leaves a blocked removal queued until the old tab closes, without duplicate requests', async () => {
  const factory = new IDBFactory()
  vi.stubGlobal('indexedDB', factory)
  const oldTab = await open(factory, 'kabanda-city-map')
  const remove = vi.spyOn(factory, 'deleteDatabase')
  removeAbandonedCityMapCache()
  removeAbandonedCityMapCache()
  expect(remove).toHaveBeenCalledTimes(1)
  expect((await factory.databases()).map(db => db.name)).toEqual(['kabanda-city-map'])
  oldTab.close()
  await vi.waitFor(async () => expect(await factory.databases()).toEqual([]))
})

it('does not throw or create a database when storage is missing or denied', () => {
  vi.stubGlobal('indexedDB', undefined)
  expect(removeAbandonedCityMapCache).not.toThrow()
  const openDatabase = vi.fn()
  vi.stubGlobal('indexedDB', {
    open: openDatabase,
    deleteDatabase: () => { throw new DOMException('Storage denied', 'SecurityError') },
  })
  expect(removeAbandonedCityMapCache).not.toThrow()
  expect(openDatabase).not.toHaveBeenCalled()
})
