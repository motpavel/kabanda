/* Imported by the existing application service worker only when Tiles API is
 * configured. This cache contains public PNGs, never API/session responses. */
(() => {
  const config = self.KABANDA_YANDEX_TILES;
  if (!config?.key) return;
  const PREFIX = new URL('_yandex_tiles/v1/', self.registration.scope).pathname;
  const MAX_BYTES = 100 * 1024 * 1024;
  const MAX_TILE = 1024 * 1024;
  const TTL = 7 * 24 * 60 * 60 * 1000;
  let database;
  let lastCleanup = 0;
  let blockedUntil = 0;
  let active = 0;
  let nextStart = 0;
  let wake;
  const queue = [];
  const inflight = new Map();

  function purgeExpired(db) {
    return new Promise(resolve => {
      try {
        const tx = db.transaction(['tiles', 'meta'], 'readwrite');
        const tiles = tx.objectStore('tiles'), meta = tx.objectStore('meta'), size = meta.get('bytes');
        size.onsuccess = () => {
          let bytes = size.result || 0;
          const request = tiles.index('created').openCursor(IDBKeyRange.upperBound(Date.now() - TTL));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) { meta.put(Math.max(0, bytes), 'bytes'); return; }
            bytes -= cursor.value.bytes; cursor.delete(); cursor.continue();
          };
        };
        tx.oncomplete = tx.onabort = tx.onerror = () => resolve();
      } catch { resolve(); }
    });
  }

  function openDatabase() {
    if (database) return database;
    database = new Promise(resolve => {
      let finished = false;
      const finish = value => { if (!finished) { finished = true; clearTimeout(timer); resolve(value); } else value?.close(); };
      const timer = setTimeout(() => finish(null), 2000);
      try {
        const request = indexedDB.open('kabanda-yandex-tiles-v1', 1);
        request.onupgradeneeded = () => {
          const tiles = request.result.createObjectStore('tiles', { keyPath: 'key' });
          tiles.createIndex('created', 'created');
          tiles.createIndex('used', 'used');
          request.result.createObjectStore('meta');
        };
        request.onsuccess = () => {
          request.result.onversionchange = () => { request.result.close(); database = null; };
          finish(request.result);
        };
        request.onerror = () => finish(null);
        request.onblocked = () => finish(null);
      } catch { finish(null); }
    });
    return database;
  }

  async function cached(key) {
    const db = await openDatabase();
    if (!db) return null;
    if (Date.now() - lastCleanup > 86400000) {
      lastCleanup = Date.now();
      await purgeExpired(db);
    }
    return new Promise(resolve => {
      let result = null;
      try {
        const tx = db.transaction(['tiles', 'meta'], 'readwrite');
        const tiles = tx.objectStore('tiles'), meta = tx.objectStore('meta');
        const read = tiles.get(key);
        read.onsuccess = () => {
          const value = read.result;
          if (!value) return;
          if (value.created <= Date.now() - TTL || value.created > Date.now()) {
            tiles.delete(key);
            const size = meta.get('bytes');
            size.onsuccess = () => meta.put(Math.max(0, (size.result || 0) - value.bytes), 'bytes');
          } else {
            result = value;
            tiles.put({ ...value, used: Date.now() });
          }
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }

  async function save(key, body) {
    const db = await openDatabase();
    if (!db) return false;
    // WebKit cannot reliably serialize service-worker-created Blob objects to
    // IndexedDB. Store the bytes; reconstruct a response on reads instead.
    const buffer = await body.arrayBuffer();
    return new Promise(resolve => {
      try {
        const tx = db.transaction(['tiles', 'meta'], 'readwrite');
        const tiles = tx.objectStore('tiles'), meta = tx.objectStore('meta');
        const previous = tiles.get(key), size = meta.get('bytes');
        let remaining = 2;
        const prepare = () => {
          if (--remaining) return;
          let bytes = Math.max(0, (size.result || 0) - (previous.result?.bytes || 0)) + body.size;
          tiles.put({ key, body: buffer, bytes: body.size, created: Date.now(), used: Date.now() });
          const finish = () => meta.put(Math.max(0, bytes), 'bytes');
          const trim = () => {
            if (bytes <= MAX_BYTES) { finish(); return; }
            const cursor = tiles.index('used').openCursor();
            cursor.onsuccess = () => {
              const entry = cursor.result;
              if (!entry || bytes <= MAX_BYTES) { finish(); return; }
              bytes -= entry.value.bytes; entry.delete(); entry.continue();
            };
          };
          const expired = tiles.index('created').openCursor(IDBKeyRange.upperBound(Date.now() - TTL));
          expired.onsuccess = () => {
            const entry = expired.result;
            if (!entry) { trim(); return; }
            bytes -= entry.value.bytes; entry.delete(); entry.continue();
          };
        };
        previous.onsuccess = size.onsuccess = prepare;
        tx.oncomplete = () => resolve(true);
        tx.onabort = tx.onerror = () => resolve(false);
      } catch { resolve(false); }
    });
  }

  function parse(url) {
    if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return null;
    const match = /^(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/.exec(url.pathname.slice(PREFIX.length));
    if (!match) return null;
    const [z, x, y] = match.slice(1).map(Number), scale = Number(url.searchParams.get('scale') || 1);
    if (z > 20 || x >= 2 ** z || y >= 2 ** z || ![1, 2].includes(scale)) return null;
    return { z, x, y, scale, key: `${z}/${x}/${y}/${scale}` };
  }

  function pump() {
    if (active >= 2 || !queue.length) return;
    const delay = Math.max(0, nextStart - Date.now());
    if (delay) { if (!wake) wake = setTimeout(() => { wake = null; pump(); }, delay); return; }
    const job = queue.shift();
    active++; nextStart = Date.now() + 170;
    Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { active--; pump(); });
    pump();
  }
  function enqueue(run, background) {
    return new Promise((resolve, reject) => {
      if (queue.length >= 96) { reject(new Error('busy')); return; }
      const job = { run, resolve, reject };
      // Keep foreground requests ahead of speculative work, without running
      // more than two upstream requests or six starts/second on this device.
      job.background = background;
      const index = background ? -1 : queue.findIndex(item => item.background);
      if (index < 0) queue.push(job); else queue.splice(index, 0, job);
      pump();
    });
  }

  async function download(tile) {
    if (Date.now() < blockedUntil) throw new Error('cooldown');
    const url = new URL('https://tiles.api-maps.yandex.ru/v1/tiles/');
    for (const [key, value] of Object.entries({ apikey: config.key, x: tile.x, y: tile.y, z: tile.z, scale: tile.scale, lang: 'ru_RU', l: 'map', maptype: 'map', projection: 'wgs84_mercator' })) url.searchParams.set(key, String(value));
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 8000);
    try {
      const response = await fetch(url, { mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: abort.signal });
      if (response.status !== 200 || !/^image\/png(?:;|$)/i.test(response.headers.get('content-type') || '')) {
        const seconds = response.status === 429 ? Math.min(60, Math.max(5, Number(response.headers.get('retry-after')) || 30)) : 30;
        blockedUntil = Date.now() + seconds * 1000;
        throw new Error('unavailable');
      }
      if (Number(response.headers.get('content-length')) > MAX_TILE) throw new Error('oversized');
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_TILE) { await reader.cancel(); throw new Error('oversized'); }
        chunks.push(value);
      }
      const body = new Blob(chunks, { type: 'image/png' });
      const signature = new Uint8Array(await body.slice(0, 8).arrayBuffer());
      if (signature.length !== 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => signature[index] === byte)) throw new Error('invalid-image');
      const end = new Uint8Array(await body.slice(-12).arrayBuffer());
      if (body.size < 45 || ![0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130].every((byte, index) => end[index] === byte)) throw new Error('truncated-image');
      const dimensions = new DataView(await body.slice(16, 24).arrayBuffer());
      if (![dimensions.getUint32(0), dimensions.getUint32(4)].every(value => value > 0 && value <= 1024)) throw new Error('invalid-dimensions');
      if (typeof createImageBitmap === 'function') {
        const decoded = await createImageBitmap(body);
        decoded.close();
      }
      if (!await save(tile.key, body)) throw new Error('storage-unavailable');
      return body;
    } catch (error) {
      blockedUntil = Math.max(blockedUntil, Date.now() + 5000);
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async function respond(event, tile, url) {
    const started = performance.now();
    const report = source => {
      if (url.searchParams.get('debug') !== '1') return;
      event.waitUntil(self.clients.get(event.clientId).then(client => client?.postMessage({
        type: 'KABANDA_TILE_TIMING', mapId: url.searchParams.get('map'), source, ms: performance.now() - started,
      })).catch(() => {}));
    };
    const hit = await cached(tile.key);
    if (hit) report('hit');
    if (hit) return new Response(hit.body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Kabanda-Tile': 'hit', 'X-Kabanda-Tile-Expires': String(hit.created + TTL) } });
    try {
      const background = url.searchParams.get('warm') === '1';
      let entry = inflight.get(tile.key);
      if (!entry) {
        entry = { foreground: !background };
        const current = entry;
        entry.promise = enqueue(() => {
          if (!current.foreground && event.request.signal.aborted) throw new Error('aborted');
          return download(tile);
        }, background);
        inflight.set(tile.key, entry);
        void entry.promise.finally(() => inflight.delete(tile.key)).catch(() => {});
      } else if (!background) entry.foreground = true;
      const body = await entry.promise;
      report('miss');
      return new Response(body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Kabanda-Tile': 'miss', 'X-Kabanda-Tile-Expires': String(Date.now() + TTL) } });
    } catch {
      report('error');
      const mapId = url.searchParams.get('map');
      if (mapId && url.searchParams.get('warm') !== '1') {
        const client = await self.clients.get(event.clientId);
        client?.postMessage({ type: 'KABANDA_YANDEX_TILE_FAILURE', mapId });
      }
      return new Response('', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return;
    const tile = parse(url);
    event.respondWith(event.request.method === 'GET' && tile ? respond(event, tile, url) : Promise.resolve(new Response('', { status: 400 })));
  });
  self.addEventListener('message', event => {
    if (event.data?.type !== 'KABANDA_YANDEX_TILES_STATUS' || !event.ports?.[0]) return;
    event.waitUntil(openDatabase().then(db => event.ports[0].postMessage({ version: 1, enabled: Boolean(db), maxBytes: MAX_BYTES, ttl: TTL })));
  });
})();
