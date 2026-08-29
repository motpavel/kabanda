let mapLibrePromise: Promise<typeof import('maplibre-gl')> | null = null

export function loadMapLibre(): Promise<typeof import('maplibre-gl')> {
  mapLibrePromise ??= Promise.all([
    import('maplibre-gl'),
    import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
  ]).then(([mapLibre, worker]) => {
    mapLibre.setWorkerUrl(worker.default)
    return mapLibre
  })
  return mapLibrePromise
}
