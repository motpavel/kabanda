export type Tile = { x: number; y: number; z: number }
const eccentricity = 0.0818191908426

/** Ellipsoidal Mercator, matching JS API 2.1 and Tiles API wgs84_mercator. */
export function tileAt(center: readonly [number, number], zoom: number): Tile {
  const z = Math.max(0, Math.min(20, Math.floor(zoom))), size = 2 ** z
  const latitude = Math.max(-85, Math.min(85, center[0])) * Math.PI / 180
  const sin = Math.sin(latitude)
  const mercator = Math.log(Math.tan(Math.PI / 4 + latitude / 2) * ((1 - eccentricity * sin) / (1 + eccentricity * sin)) ** (eccentricity / 2))
  return {
    x: ((Math.floor((center[1] + 180) / 360 * size) % size) + size) % size,
    y: Math.max(0, Math.min(size - 1, Math.floor((1 - mercator / Math.PI) / 2 * size))), z,
  }
}

export function tilePath(tile: Tile, scale: number, mapId: string, base: string): string {
  return `${base}_yandex_tiles/v1/${tile.z}/${tile.x}/${tile.y}.png?scale=${scale}&map=${encodeURIComponent(mapId)}`
}

/** Small edge reserve only, never enumerate a city or every zoom level. */
export function nearbyTiles(center: readonly [number, number], zoom: number, width: number, height: number): Tile[] {
  if (!Number.isFinite(zoom) || !center.every(Number.isFinite) || width <= 0 || height <= 0) return []
  // Speculative loading is confined to Izhevsk and its immediate surroundings.
  if (center[0] < 56.7 || center[0] > 57 || center[1] < 53 || center[1] > 53.4) return []
  const origin = tileAt(center, zoom), size = 2 ** origin.z
  const dx = Math.min(5, Math.ceil(width / 512)), dy = Math.min(5, Math.ceil(height / 512))
  const candidates: Tile[] = []
  for (let y = origin.y - dy - 1; y <= origin.y + dy + 1; y++) {
    for (let x = origin.x - dx - 1; x <= origin.x + dx + 1; x++) {
      if (Math.abs(x - origin.x) <= dx && Math.abs(y - origin.y) <= dy) continue
      if (x >= 0 && y >= 0 && x < size && y < size) candidates.push({ x, y, z: origin.z })
    }
  }
  candidates.sort((a, b) => (a.x - origin.x) ** 2 + (a.y - origin.y) ** 2 - (b.x - origin.x) ** 2 - (b.y - origin.y) ** 2)
  const result = candidates.slice(0, 10)
  if (origin.z < 20) result.push(tileAt(center, origin.z + 1))
  if (origin.z > 0) result.push(tileAt(center, origin.z - 1))
  return result
}
