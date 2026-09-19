import { ApiError, requestJson } from '../../lib/http'
import { subscribeConfirmedWrites } from '../../lib/api-events'
import { isRaidProjection } from './cache'
import type { RaidProjection,RaidMapPoint,RouteTrackProjection } from './types'
import type { CheckInClaim,CheckInFallback } from '../checkins/types'

export type LivePosition={userId:string;latitude:number;longitude:number;accuracyMeters:number;capturedAt:string}
export interface RaidLiveSnapshot {
  raid:RaidProjection
  revision?:string
  serverAt?:string
  teamVisits?:boolean
  positions?:LivePosition[]
  track?:RouteTrackProjection
  points?:Array<RaidMapPoint & {lastAttemptId?:string|null}>
  claims?:CheckInClaim[]
  fallbacks?:CheckInFallback[]
}
export type LiveState={data:RaidLiveSnapshot|null;error:unknown|null;denied:boolean;receivedAt:number}

/** One in-flight READ for map, lifecycle and inbox. Critical writes fence old
 * replies; media/GPS do not tear down unrelated reads. No write is aborted. */
export class RaidLiveFeed {
  state:LiveState={data:null,error:null,denied:false,receivedAt:0}
  private listeners=new Set<()=>void>()
  private pending:Promise<RaidLiveSnapshot>|null=null
  private controller:AbortController|null=null
  private generation=0
  private failures=0
  private timer:ReturnType<typeof setTimeout>|undefined
  private retired=false
  private legacy=false
  constructor(readonly raidId:string,private readonly load=async(path:string,signal:AbortSignal)=>requestJson<RaidLiveSnapshot>(path,{signal}),
    private readonly now=Date.now,private readonly allowed=()=>typeof document==='undefined'||document.visibilityState==='visible'&&navigator.onLine){}
  snapshot=()=>this.state
  private publish(state:LiveState){this.state=state;for(const listener of this.listeners)listener()}
  private schedule(elapsed=0){
    clearTimeout(this.timer)
    if(this.retired||!this.listeners.size)return
    const delay=this.failures?Math.min(15000,1000*2**Math.min(this.failures,4)):Math.max(250,1000-elapsed)
    this.timer=setTimeout(()=>{if(this.allowed())void this.refresh(true).catch(()=>undefined);else this.schedule()},delay)
  }
  subscribe=(listener:()=>void)=>{
    this.listeners.add(listener)
    if(this.listeners.size===1){if(this.allowed())void this.refresh().catch(()=>undefined);else this.schedule()}
    return ()=>{this.listeners.delete(listener);if(!this.listeners.size)clearTimeout(this.timer)}
  }
  invalidate(){this.generation++;this.controller?.abort();this.controller=null;this.pending=null;this.state={...this.state,receivedAt:0}}
  retire(){this.retired=true;this.invalidate();clearTimeout(this.timer);this.publish({data:null,error:null,denied:false,receivedAt:0})}
  resume=()=>{if(this.listeners.size&&this.allowed())void this.refresh(true).catch(()=>undefined)}
  refresh=(force=false):Promise<RaidLiveSnapshot>=>{
    if(this.retired)return Promise.reject(new TypeError('Live read retired'))
    if(this.pending)return this.pending
    if(!force&&this.state.data&&this.now()-this.state.receivedAt<400)return Promise.resolve(structuredClone(this.state.data))
    const generation=this.generation,start=this.now(),controller=new AbortController()
    this.controller=controller
    const deadline=setTimeout(()=>controller.abort(new DOMException('Live read timed out','TimeoutError')),12000)
    const path=`/api/raids/${encodeURIComponent(this.raidId)}`
    const pending=(async()=>{
      let data:RaidLiveSnapshot
      try{data=await this.load(this.legacy?`${path}/live`:`${path}/fast/live`,controller.signal)}
      catch(error){
        // Compatibility with an old server is allowed only for an unknown new
        // endpoint, never by interpreting a resource/access denial as success.
        if(!this.legacy&&error instanceof ApiError&&error.status===404&&error.code==='NOT_FOUND'){
          this.legacy=true;data=await this.load(`${path}/live`,controller.signal)
        }else throw error
      }
      if(this.retired||generation!==this.generation)throw new TypeError('Live read superseded')
      if(!data||!isRaidProjection(data.raid)||data.raid.id!==this.raidId)throw new TypeError('Invalid live snapshot')
      if(data.revision!==undefined&&!/^[0-9]{1,20}$/.test(data.revision))throw new TypeError('Invalid live revision')
      const previous=this.state.data
      if(previous?.revision&&data.revision&&BigInt(data.revision)<BigInt(previous.revision))throw new TypeError('Live revision went backwards')
      if(previous&&data.raid.version<previous.raid.version)throw new TypeError('Raid version went backwards')
      this.failures=0
      this.publish({data,error:null,denied:false,receivedAt:this.now()})
      return structuredClone(data)
    })().catch(error=>{
      if(!this.retired&&generation===this.generation){
        this.failures++
        const denied=error instanceof ApiError&&[401,403,404].includes(error.status)
        this.publish({...this.state,data:denied?null:this.state.data,error,denied})
      }
      throw error
    }).finally(()=>{
      clearTimeout(deadline)
      if(this.pending===pending){this.pending=null;this.controller=null;this.schedule(this.now()-start)}
    })
    this.pending=pending
    return pending
  }
}

const feeds=new Map<string,RaidLiveFeed>()
export function liveRaid(raidId:string){
  let feed=feeds.get(raidId)
  if(!feed){feed=new RaidLiveFeed(raidId);feeds.set(raidId,feed)}
  return feed
}
export function resetLiveFeeds(){for(const feed of feeds.values())feed.retire();feeds.clear()}
subscribeConfirmedWrites(event=>{
  const match=/^\/api\/raids\/([^/]+)\/(?:check-ins(?:\/|$)|check-in-claims\/|check-in-fallbacks|commands\/|participants\/|destination$|finalization\/)/.exec(event.path)
  if(!match)return
  const feed=feeds.get(match[1]!)
  if(feed){feed.invalidate();feed.resume()}
})
if(typeof window!=='undefined'){
  window.addEventListener('kabanda:identity-changed',resetLiveFeeds)
  window.addEventListener('storage',event=>{if(event.key===null||event.key==='kabanda:relay-session:v1')resetLiveFeeds()})
  for(const event of ['online','focus','pageshow'])window.addEventListener(event,()=>{for(const feed of feeds.values())feed.resume()})
  document.addEventListener('visibilitychange',()=>{for(const feed of feeds.values())feed.resume()})
}
