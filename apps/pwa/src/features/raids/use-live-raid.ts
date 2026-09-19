import { useMemo,useSyncExternalStore } from 'react'
import { liveRaid } from './live-feed'
const idleSubscribe=()=>()=>{}
export function useLiveRaid(identityId:string,raidId:string,active=true){
  const feed=useMemo(()=>liveRaid(raidId),[identityId,raidId])
  const state=useSyncExternalStore(active?feed.subscribe:idleSubscribe,feed.snapshot,feed.snapshot)
  return {...state,refresh:feed.refresh,feed}
}
