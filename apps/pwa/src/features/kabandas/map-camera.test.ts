import { describe, expect, it, vi } from 'vitest'
import { MapCamera, MAP_RECENTER_MS } from './map-camera'
import type { YandexCoordinates, YandexMap } from './yandex-maps'

const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
function harness(reduced = false) {
  let center: YandexCoordinates = [56, 53]
  let zoom = 13
  const pending: { finish: () => void; fail: () => void }[] = []
  const action = (finish: () => void) => new Promise<void>((resolve, reject) => pending.push({
    finish: () => { finish(); resolve() }, fail: () => reject(new Error('interrupted')),
  }))
  const map = {
    getCenter: () => center, getZoom: () => zoom,
    panTo: vi.fn((target: YandexCoordinates) => action(() => { center = target })),
    setCenter: vi.fn((target: YandexCoordinates) => { center = target }),
    setZoom: vi.fn((target: number) => action(() => { zoom = target })),
  }
  return { map, pending, camera: new MapCamera(map as unknown as YandexMap, () => reduced) }
}

describe('map camera', () => {
  it('flies to the user while preserving zoom on the ordinary map', async () => {
    const { camera, map, pending } = harness()
    camera.center([56.86, 53.21])
    expect(map.panTo).toHaveBeenCalledWith([56.86, 53.21], { duration: MAP_RECENTER_MS, flying: true, timingFunction: 'ease-in-out' })
    expect(map.setCenter).not.toHaveBeenCalled()
    expect(map.setZoom).not.toHaveBeenCalled()
    pending[0]!.finish(); await tick()
    camera.track([56.87, 53.22])
    expect(map.setCenter).not.toHaveBeenCalled()
  })

  it('does not let moving rider frames interrupt centering, then follows the latest drawn position', async () => {
    const { camera, map, pending } = harness()
    camera.center([56.86, 53.21], true)
    camera.track([56.8601, 53.21])
    camera.track([56.8602, 53.21])
    expect(map.setCenter).not.toHaveBeenCalled()
    pending[0]!.finish(); await tick()
    expect(map.panTo).toHaveBeenLastCalledWith([56.8602, 53.21], { duration: 180, flying: false, safe: false, timingFunction: 'ease-out' })
    camera.track([56.8603, 53.21])
    expect(map.setCenter).not.toHaveBeenCalled()
    pending[1]!.finish(); await tick()
    camera.track([56.8604, 53.21])
    camera.track([56.8604, 53.21])
    expect(map.setCenter).toHaveBeenCalledTimes(1)
    expect(map.setCenter).toHaveBeenLastCalledWith([56.8604, 53.21], 13, { duration: 0 })
  })

  it('allows zoom animation while following without old flight completion resuming tracking early', async () => {
    const { camera, map, pending } = harness()
    camera.center([56.86, 53.21], true)
    camera.zoom(14)
    pending[0]!.finish(); await tick()
    camera.track([56.8602, 53.21])
    expect(map.setCenter).not.toHaveBeenCalled()
    pending[1]!.finish(); await tick()
    pending[2]!.finish(); await tick()
    camera.track([56.8603, 53.21])
    expect(map.setCenter).toHaveBeenLastCalledWith([56.8603, 53.21], 14, { duration: 0 })
  })

  it('does not resume follow after a user pan or map disposal', async () => {
    const { camera, map, pending } = harness()
    camera.center([56.86, 53.21], true)
    camera.stop()
    camera.track([56.8602, 53.21])
    pending[0]!.finish(); await tick()
    camera.track([56.8603, 53.21])
    expect(map.panTo).toHaveBeenCalledTimes(1)
    expect(map.setCenter).not.toHaveBeenCalled()
  })

  it('honors reduced motion for centering and zoom', () => {
    const { camera, map } = harness(true)
    camera.center([56.86, 53.21])
    camera.zoom(15)
    expect(map.panTo).toHaveBeenLastCalledWith([56.86, 53.21], expect.objectContaining({ duration: 0 }))
    expect(map.setZoom).toHaveBeenLastCalledWith(15, { duration: 0 })
  })

  it('recovers if the SDK interrupts an animation', async () => {
    const { camera, map, pending } = harness()
    camera.center([56.86, 53.21], true)
    pending[0]!.fail(); await tick()
    camera.track([56.8601, 53.21])
    expect(map.setCenter).toHaveBeenCalledTimes(1)
  })
})
