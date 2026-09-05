import { describe, expect, it } from 'vitest'
import { nearbyCachedPoints } from './proximity'

describe('offline raid proximity', () => {
  it('finds a new cached point after GPS moves, preserving separate personal/team status', () => {
    const points = [{id:'a',sourcePointId:'source',name:'Точка',latitude:56.86,longitude:53.21,position:0,visitedByMe:false,visitedByTeam:true}]
    const fix = {latitude:56.861,longitude:53.21,accuracyMeters:8,capturedAt:new Date().toISOString()}
    expect(nearbyCachedPoints(points,fix)).toEqual([])
    expect(nearbyCachedPoints(points,{...fix,latitude:56.86001})[0]).toMatchObject({pointSnapshotId:'a',creditedByMe:false,creditedByTeam:true})
  })
})
