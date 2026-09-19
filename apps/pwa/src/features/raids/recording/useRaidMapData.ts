import {useEffect,useRef,useState} from 'react'
import {ApiError,requestJson} from '../../../lib/http'
import {offlineDb} from '../../offline/db'
import {getRaidMapPoints,getRaidSnapshot} from '../api'
import {useLiveRaid} from '../use-live-raid'
import type {RaidMapPoint,RouteTrackProjection} from '../types'
import {readRaidMapCache,saveRaidMapCache} from './map-cache'

export function useRaidMapData(identityId:string,raidId:string,live:boolean,completed:boolean){
  const snapshot=useLiveRaid(identityId,raidId,live)
  const [track,setTrack]=useState<RouteTrackProjection|null>(null)
  const [points,setPoints]=useState<RaidMapPoint[]>([])
  const [dataState,setDataState]=useState<'loading'|'ready'|'failed'>('loading')
  const current=useRef({identityId,raidId,denied:snapshot.denied})
  current.current={identityId,raidId,denied:snapshot.denied}
  const lastStored=useRef('')
  useEffect(()=>{
    let active=true
    setTrack(null);setPoints([]);setDataState('loading');lastStored.current=''
    void readRaidMapCache(identityId,raidId).then(cached=>{
      if(!active||!cached||current.current.denied)return
      setTrack(old=>old??cached.track)
      setPoints(old=>old.length?old:cached.points)
    }).catch(()=>undefined)
    if(!live)void getRaidSnapshot(raidId).then(next=>{
      if(!active)return
      if(next.points)setPoints(next.points)
      if(next.track)setTrack(next.track)
      setDataState('ready')
    }).catch(()=>{if(active)setDataState('failed')})
    return ()=>{active=false}
  },[identityId,raidId,live,completed])
  useEffect(()=>{
    if(snapshot.denied){
      setTrack(null);setPoints([]);setDataState('failed')
      void offlineDb.raidMapCache.delete(JSON.stringify([identityId,raidId])).catch(()=>undefined)
      return
    }
    const value=snapshot.data
    if(value?.raid.id===raidId){
      if(value.points)setPoints(previous=>JSON.stringify(previous)===JSON.stringify(value.points)?previous:value.points!)
      if(value.track)setTrack(previous=>previous?.updatedAt===value.track!.updatedAt&&previous.pointCount===value.track!.pointCount?previous:value.track!)
      setDataState(snapshot.error?'failed':'ready')
    }else if(snapshot.error)setDataState('failed')
  },[snapshot.data,snapshot.error,snapshot.denied,identityId,raidId])
  useEffect(()=>{
    let active=true,inFlight=false,controller:AbortController|null=null,lastRevision:string|null=null
    const refresh=async()=>{
      if(inFlight||!navigator.onLine||document.visibilityState!=='visible'||snapshot.feed.state.denied)return
      const value=snapshot.feed.state.data
      if(value?.track)return // Legacy server/test snapshot already contains it.
      if(!value||!['active','paused','finalizing','completed'].includes(value.raid.state)){
        if(!live&&!completed){try{const rows=await getRaidMapPoints(raidId);if(active)setPoints(rows)}catch{/* Keep cached route planning. */}}
        return
      }
      const revision=JSON.stringify([value.raid.state,value.raid.routeStatus.lastSampleAt,value.raid.routeStatus.acceptedSampleCount])
      if(revision===lastRevision)return
      inFlight=true;controller=new AbortController()
      const timeout=setTimeout(()=>controller?.abort(),12000)
      try{
        const result=await requestJson<{track:RouteTrackProjection}>(`/api/raids/${encodeURIComponent(raidId)}/route/track`,{signal:controller.signal})
        if(active&&!snapshot.feed.state.denied&&result.track&&Array.isArray(result.track.segments)){
          lastRevision=revision;setTrack(result.track);setDataState('ready')
        }
      }catch(error){
        if(active){
          setDataState('failed')
          if(error instanceof ApiError&&[401,403,404].includes(error.status)){
            setTrack(null);setPoints([])
            void offlineDb.raidMapCache.delete(JSON.stringify([identityId,raidId])).catch(()=>undefined)
          }
        }
      }finally{clearTimeout(timeout);inFlight=false;controller=null}
    }
    const changed=()=>{if(lastRevision===null)void refresh()}
    // A first lightweight response starts the independent route load. Further
    // point/position replies never wait for it and never refetch the old track.
    const unsubscribe=snapshot.feed.subscribe(changed)
    void refresh()
    const timer=setInterval(()=>void refresh(),live?10000:30000)
    return ()=>{active=false;unsubscribe();controller?.abort();clearInterval(timer)}
  },[identityId,raidId,live,completed,snapshot.feed])
  useEffect(()=>{
    if(!track||snapshot.denied)return
    const signature=JSON.stringify([track.updatedAt,track.pointCount,points])
    if(signature===lastStored.current)return
    lastStored.current=signature
    void saveRaidMapCache(identityId,raidId,points,track).catch(()=>undefined)
  },[identityId,raidId,track,points,snapshot.denied])
  return {track,points,dataState,positions:snapshot.data?.positions,
    snapshotNavigator:snapshot.data?{userId:snapshot.data.raid.navigatorUserId,sampleAt:snapshot.data.raid.routeStatus.lastSampleAt}:null}
}
