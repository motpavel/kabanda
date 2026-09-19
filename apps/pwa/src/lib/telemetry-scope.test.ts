import {describe,expect,it} from 'vitest'
import {telemetryReadScope} from './http'

describe('telemetry read invalidation scope',()=>{
  it('does not turn normal commands or account writes into telemetry',()=>{
    for(const path of ['/api/auth/login','/api/raids/r/check-ins/team','/api/raids/r/commands/pause','/api/raids/r/presence/u/manual']){
      expect(telemetryReadScope(path,'POST')).toBeNull()
      expect(telemetryReadScope(path,'PUT')).toBeNull()
    }
    expect(telemetryReadScope('/api/raids/r/presence/me','GET')).toBeNull()
    expect(telemetryReadScope('/api/raids/r/route/batches','GET')).toBeNull()
  })
  it('only invalidates presence reads of the exact raid',()=>{
    const matches=telemetryReadScope('/api/raids/r/presence/me','PUT')!
    expect(matches('/api/raids/r/check-ins/presence?pointSnapshotId=p')).toBe(true)
    expect(matches('/api/raids/r/presence')).toBe(true)
    expect(matches('/api/raids/r/live')).toBe(true)
    for(const path of ['/api/raids/other/live','/api/raids/r/result','/api/raids/r/route/track','/api/kabandas/t/raids','/api/me'])expect(matches(path)).toBe(false)
  })
  it('route batches do not clear history, photos or unrelated in-flight readers',()=>{
    const matches=telemetryReadScope('/api/raids/r/route/batches','POST')!
    expect(matches('/api/raids/r/route/track')).toBe(true)
    expect(matches('/api/raids/r/live')).toBe(true)
    for(const path of ['/api/raids/other/route/track','/api/raids/r/media','/api/kabandas/t/raids/history/page','/api/raids/r/check-ins/presence'])expect(matches(path)).toBe(false)
  })
})
