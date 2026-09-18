import { describe, expect, it } from 'vitest'
import { ScreenScrollMemory } from './screen-scroll'

describe('ephemeral screen positions', () => {
  it('starts new screens at the top and restores each team/tab independently', () => {
    const memory = new ScreenScrollMemory()
    const raids = JSON.stringify(['user', 'crew', 'raids'])
    const home = JSON.stringify(['user', 'crew', 'home'])
    const other = JSON.stringify(['user', 'other-crew', 'raids'])
    expect(memory.read(raids)).toEqual({ x: 0, y: 0 })
    memory.save(raids, { x: 0, y: 782 })
    memory.save(home, { x: 0, y: 210 })
    expect(memory.read(raids).y).toBe(782)
    expect(memory.read(home).y).toBe(210)
    expect(memory.read(other).y).toBe(0)
    expect(new ScreenScrollMemory().read(raids).y).toBe(0)
  })
  it('ignores non-finite coordinates, clamps elastic overscroll and returns copies', () => {
    const memory = new ScreenScrollMemory()
    memory.save('a', { x: -1, y: -22 })
    expect(memory.read('a')).toEqual({ x: 0, y: 0 })
    memory.save('a', { x: 0, y: 180 })
    memory.save('a', { x: 0, y: NaN })
    const copy = memory.read('a'); copy.y = 99
    expect(memory.read('a').y).toBe(180)
  })
  it('bounds memory instead of accumulating an unlimited browsing history', () => {
    const memory = new ScreenScrollMemory()
    for (let i = 0; i < 65; i++) memory.save(String(i), { x: 0, y: i + 1 })
    expect(memory.read('0').y).toBe(0)
    expect(memory.read('64').y).toBe(65)
  })
})
