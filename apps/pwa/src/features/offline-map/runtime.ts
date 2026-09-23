import type { StyleSpecification } from 'maplibre-gl'
import { PMTiles, Protocol, type Source } from 'pmtiles'
import { layers, namedFlavor } from '@protomaps/basemaps'
import { loadMapLibre } from '../kabandas/maplibre'
import type { DisplayMapRuntime } from '../kabandas/yandex-maps'
import { cityArchiveStore } from './archive-store'
import { CityMapBundle } from './bundle'
import { IZHEVSK_ARCHIVE } from './manifest'
import { createMapLibreRuntime } from './maplibre-runtime'
import 'maplibre-gl/dist/maplibre-gl.css'

let runtimePromise: Promise<DisplayMapRuntime> | null = null

/** One renderer/protocol registry per document, shared by free and raid maps. */
export function loadOfflineMapRuntime(): Promise<DisplayMapRuntime> {
  runtimePromise ??= initialize().catch(error => { runtimePromise = null; throw error })
  return runtimePromise
}

async function initialize(): Promise<DisplayMapRuntime> {
  const cached = await cityArchiveStore.read()
  const spec = cached?.spec ?? IZHEVSK_ARCHIVE
  if (!cached && navigator.onLine === false) throw new Error('Карта Ижевска ещё не сохранена. Откройте её с интернетом один раз.')
  const bundle = new CityMapBundle({ spec, blob: cached?.blob })
  // First view can use small HTTP ranges while the complete city downloads.
  // An already open map keeps its immutable version until the next document.
  void cityArchiveStore.ensure(IZHEVSK_ARCHIVE).then(blob => {
    if (blob && spec.sha256 === IZHEVSK_ARCHIVE.sha256) bundle.setBlob(blob)
  })
  const [maplibre] = await Promise.all([loadMapLibre(), bundle.initialize()])
  // A manual retry (or Save Data opt-in) can complete after initial setup.
  // Adopt that Blob as well, so subsequent panning never keeps using HTTP.
  if (!cached && spec.sha256 === IZHEVSK_ARCHIVE.sha256) {
    const adopt = () => {
      if (cityArchiveStore.getSnapshot().status !== 'ready') return
      unsubscribe()
      void cityArchiveStore.read(IZHEVSK_ARCHIVE).then(archive => { if (archive) bundle.setBlob(archive.blob) })
    }
    const unsubscribe = cityArchiveStore.subscribe(adopt)
    adopt()
  }
  const key = `izhevsk-${spec.sha256}`
  const source: Source = {
    getKey: () => key,
    getBytes: async (offset, length, signal) => ({ data: await bundle.readRange('basemap.pmtiles', offset, length, signal) }),
  }
  const tiles = new PMTiles(source)
  await tiles.getHeader()
  const protocol = new Protocol()
  protocol.add(tiles)
  maplibre.addProtocol('pmtiles', protocol.tilev4)
  maplibre.addProtocol('kabanda-map', async (request, controller) => {
    const url = new URL(request.url)
    if (url.hostname !== 'city') throw new Error('Unknown map package')
    const path = decodeURIComponent(url.pathname.slice(1))
    const data = await bundle.readFile(path, controller.signal)
    return { data: request.type === 'json' ? JSON.parse(new TextDecoder().decode(data)) : data }
  })
  const style: StyleSpecification = {
    version: 8,
    glyphs: 'kabanda-map://city/fonts/{fontstack}/{range}.pbf',
    sprite: 'kabanda-map://city/sprites/light',
    sources: { city: {
      type: 'vector', url: `pmtiles://${key}`,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · <a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a>',
    } },
    // Keep all font references inside the package, including fallback scripts.
    layers: JSON.parse(JSON.stringify(layers('city', namedFlavor('light'), { lang: 'ru' }))
      .replaceAll('Noto Sans Devanagari Regular v1', 'Noto Sans Regular')) as StyleSpecification['layers'],
  }
  return createMapLibreRuntime(maplibre, style)
}
