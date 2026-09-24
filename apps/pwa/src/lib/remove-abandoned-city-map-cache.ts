let pendingRemoval: IDBOpenDBRequest | null = null

/** Release the abandoned public basemap download without touching private data. */
export function removeAbandonedCityMapCache(): void {
  if (pendingRemoval) return
  try {
    if (typeof indexedDB === 'undefined') return
    const request = indexedDB.deleteDatabase('kabanda-city-map')
    pendingRemoval = request
    request.onsuccess = () => { pendingRemoval = null }
    request.onerror = event => {
      event.preventDefault()
      pendingRemoval = null
    }
    // A blocked deletion stays queued in IndexedDB and resumes automatically
    // when the older tab closes its connection. It never blocks app startup.
  } catch {
    // Storage may be unavailable in private browsing or restricted webviews.
    pendingRemoval = null
  }
}
