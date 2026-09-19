import { useCallback,useEffect,useRef,useState } from 'react'
import { getNearbyPoints } from '../../checkins/api'
import { getOneShotCoordinate } from '../../checkins/platform'
import type { NearbyPoint,OneShotCoordinate } from '../../checkins/types'
import { reportRaidPresence } from '../api'
import { readRaidMapCache } from './map-cache'
import { nearbyCachedPoints } from './proximity'
import { readRecordedLocation,subscribeRecordedLocation } from './live-location'

export type RaidProximityState={status:'locating'|'ready'|'offline'|'blocked';coordinate:OneShotCoordinate|null;nearby:NearbyPoint[];refresh:()=>Promise<void>}
export function useRaidProximity(identityId:string,raidId:string,enabled:boolean):RaidProximityState{
  const [status,setStatus]=useState<RaidProximityState['status']>(()=>navigator.onLine?'locating':'offline')
  const [coordinate,setCoordinate]=useState<OneShotCoordinate|null>(null)
  const [nearby,setNearby]=useState<NearbyPoint[]>([])
  const latest=useRef<OneShotCoordinate|null>(null),scope=useRef(0),inFlight=useRef(false)
  const presence=useRef({busy:false,lastSentAt:0,lastCapturedAt:'',pending:null as OneShotCoordinate|null})
  const sendPresence=useCallback(async(next:OneShotCoordinate)=>{
    const age=Date.now()-Date.parse(next.capturedAt)
    if(!enabled||!navigator.onLine||document.visibilityState!=='visible'||next.accuracyMeters>50||age< -5000||age>10000)return
    const current=presence.current
    current.pending=next
    if(current.busy||Date.now()-current.lastSentAt<2000||current.lastCapturedAt===next.capturedAt)return
    current.busy=true
    const generation=scope.current
    try{
      const selected=current.pending;current.pending=null
      current.lastSentAt=Date.now()
      await reportRaidPresence(raidId,selected)
      if(generation===scope.current)current.lastCapturedAt=selected.capturedAt
    }catch{/* Presence is an ephemeral latest-fix message, never an offline credit. */}
    finally{current.busy=false}
  },[enabled,raidId])
  const accept=useCallback((next:OneShotCoordinate)=>{
    const previous=latest.current
    if(previous&&Date.parse(previous.capturedAt)>Date.parse(next.capturedAt))return
    latest.current=next;setCoordinate(next)
    // Do not await catalogue, a full route read or a photograph before presence.
    void sendPresence(next)
  },[sendPresence])
  const refresh=useCallback(async()=>{
    if(!enabled||inFlight.current||document.visibilityState!=='visible')return
    const generation=scope.current
    inFlight.current=true
    try{
      const recent=latest.current
      const next=recent&&Date.now()-Date.parse(recent.capturedAt)<=5000?recent:
        readRecordedLocation({identityId,raidId})??await getOneShotCoordinate(10000)
      if(generation!==scope.current)return
      accept(next)
      const cached=await readRaidMapCache(identityId,raidId).catch(()=>null)
      if(generation!==scope.current)return
      setNearby(nearbyCachedPoints(cached?.points??[],next))
      if(!navigator.onLine){setStatus('offline');return}
      try{
        const response=await getNearbyPoints(raidId,next.latitude,next.longitude)
        if(generation===scope.current){setNearby(response.points);setStatus('ready')}
      }catch{if(generation===scope.current)setStatus('offline')}
    }catch(error){
      if(generation===scope.current){setNearby([]);setStatus(error&&typeof error==='object'&&'code'in error&&error.code===1?'blocked':'locating')}
    }finally{if(generation===scope.current)inFlight.current=false}
  },[enabled,identityId,raidId,accept])
  useEffect(()=>{
    scope.current++;latest.current=null;inFlight.current=false;setCoordinate(null);setNearby([])
    presence.current={busy:false,lastSentAt:0,lastCapturedAt:'',pending:null}
    if(!enabled)return
    let active=true,watch:number|undefined
    const receive=(next:OneShotCoordinate)=>{if(active&&document.visibilityState==='visible')accept(next)}
    const unsubscribe=subscribeRecordedLocation({identityId,raidId},receive)
    const start=()=>{
      if(!active||watch!==undefined||document.visibilityState!=='visible'||!navigator.geolocation)return
      watch=navigator.geolocation.watchPosition(position=>{
        if(!active)return
        const age=Date.now()-position.timestamp
        if(age< -5000||age>5000)return
        receive({latitude:position.coords.latitude,longitude:position.coords.longitude,accuracyMeters:position.coords.accuracy,capturedAt:new Date(position.timestamp).toISOString()})
      },error=>{if(active&&error.code===1)setStatus('blocked')},{enableHighAccuracy:true,maximumAge:1000,timeout:10000})
    }
    const resume=()=>{
      if(document.visibilityState==='visible'){start();void refresh();if(latest.current)void sendPresence(latest.current)}
      else if(watch!==undefined){navigator.geolocation.clearWatch(watch);watch=undefined}
    }
    start();void refresh()
    const timer=setInterval(()=>void refresh(),8000)
    const heartbeat=setInterval(()=>{const next=presence.current.pending??latest.current;if(next)void sendPresence(next)},2000)
    window.addEventListener('online',resume);window.addEventListener('focus',resume);document.addEventListener('visibilitychange',resume)
    return ()=>{
      active=false;scope.current++;unsubscribe();if(watch!==undefined)navigator.geolocation.clearWatch(watch)
      clearInterval(timer);clearInterval(heartbeat)
      window.removeEventListener('online',resume);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume)
    }
  },[enabled,identityId,raidId,accept,refresh,sendPresence])
  return {status,coordinate,nearby,refresh}
}
