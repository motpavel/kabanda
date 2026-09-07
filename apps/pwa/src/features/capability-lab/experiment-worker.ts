/// <reference lib="webworker" />
// Independent IndexedDB writer. A worker heartbeat is evidence of execution/storage,
// never evidence of geolocation. This worker makes no network requests.
const workerScope = self as unknown as DedicatedWorkerGlobalScope
let timer: ReturnType<typeof setInterval> | undefined
let database: IDBDatabase | undefined
workerScope.onmessage = (event: MessageEvent<{ database: string; runId: string; startedAt: number; limitMs: number }>) => {
  if (timer) clearInterval(timer)
  const { database: name, runId, startedAt, limitMs } = event.data
  const request = indexedDB.open(name)
  request.onupgradeneeded = () => request.transaction?.abort()
  request.onerror = () => workerScope.postMessage({ error: request.error?.message ?? 'Worker storage unavailable' })
  request.onsuccess = () => {
    database = request.result
    workerScope.postMessage({ ready: true, gpsAvailable: 'geolocation' in navigator })
    const tick = () => {
      if (Date.now() - startedAt >= limitMs) {
        clearInterval(timer)
        database?.close()
        workerScope.close()
        return
      }
      const receivedAt = Date.now()
      const row = {
        id: crypto.randomUUID(), runId, kind: 'worker.tick', receivedAt,
        monotonicAt: performance.timeOrigin + performance.now(), visibility: 'worker',
      }
      try {
        const transaction = database!.transaction('events', 'readwrite')
        transaction.objectStore('events').put(row)
        transaction.oncomplete = () => {
          const committedAt = Date.now()
          try {
            const confirmation = database!.transaction('events', 'readwrite')
            confirmation.objectStore('events').put({ ...row, committedAt, persistedVisibility: 'worker' })
            confirmation.oncomplete = () => workerScope.postMessage({ tick: receivedAt, committedAt })
            confirmation.onerror = () => workerScope.postMessage({ error: 'Worker acknowledgement failed' })
          } catch (error) { workerScope.postMessage({ error: String(error) }) }
        }
        transaction.onerror = () => workerScope.postMessage({ error: transaction.error?.message ?? 'Worker write failed' })
      } catch (error) {
        workerScope.postMessage({ error: String(error) })
      }
    }
    tick()
    timer = setInterval(tick, 5_000)
  }
}
