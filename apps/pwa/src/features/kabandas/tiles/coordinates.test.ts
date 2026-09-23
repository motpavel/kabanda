import { describe, expect, it } from 'vitest'
import { nearbyTiles, tileAt, tilePath } from './coordinates'

describe('Yandex tile coordinates', () => {
  it('uses ellipsoidal Mercator for Izhevsk and wraps the date line', () => {
    expect(tileAt([56.8528, 53.2045], 14)).toEqual({ x: 10613, y: 5046, z: 14 })
    expect(tileAt([0, 180], 3).x).toBe(0)
    expect(tileAt([0, -180], 3).x).toBe(0)
    expect(tileAt([90, 0], 30).y).toBeGreaterThanOrEqual(0)
  })
  it('keeps retina density and each map client separate without putting the API key in tile URLs', () => {
    expect(tilePath({ x: 1, y: 2, z: 3 }, 2, 'a/b', '/kabanda/')).toBe('/kabanda/_yandex_tiles/v1/3/1/2.png?scale=2&map=a%2Fb')
  })
  it('bounds speculative requests and stops them outside the city or a hidden viewport', () => {
    const tiles = nearbyTiles([56.8528, 53.2045], 17, 390, 844)
    expect(tiles).toHaveLength(12)
    expect(new Set(tiles.map(tile => `${tile.z}/${tile.x}/${tile.y}`)).size).toBe(tiles.length)
    expect(tiles.every(tile => tile.x >= 0 && tile.y >= 0 && tile.x < 2 ** tile.z && tile.y < 2 ** tile.z)).toBe(true)
    expect(nearbyTiles([55.75, 37.6], 17, 390, 844)).toEqual([])
    expect(nearbyTiles([56.8528, 53.2045], 17, 0, 0)).toEqual([])
  })
})
