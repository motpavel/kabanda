# PWA loading and live reads

The main application and GPS recorder remain available from the service worker's
precache. Prototypes and desktop decoration load on demand. Public illustration
files are cached when visited; authenticated API and Relay responses never enter
service-worker caches. Build filtering defaults to retaining newly added assets
so a future recording dependency is not silently omitted from offline operation.

The in-memory JSON read cache shares concurrent GETs. Only explicitly configured
resources have a short freshness window. Every mutation invalidates these windows
before and after its request; identity/cross-tab session changes also fence late
successful and failed reads. Local previews remain scoped to the current identity
and are marked stale until the server confirms them. Stale previews never enable
start/check-in mutations. A recently verified user is reused for 15 seconds across
navigation; logout and identity changes clear it.

Only visible screens poll. A poll starts its next interval after the current read
settles, and focus/visibility bursts share the same pending request. Actionable
lists refresh every 10 seconds, history every 60 seconds; critical raid state
continues to refresh every 5 seconds. Manual actions can request immediate reads.
History, actionable raids and template catalog load independently.

`GET /api/raids/:raidId/live` combines the lifecycle, map and pending claim/fallback
read models into one Relay response. Each optional model retains its original
server authorization. Optional failures omit that model without hiding the raid
lifecycle. The response is private/no-store; a 3-second in-memory window lets the
map and lifecycle consumers share it. This is a group of read models, not a
transactional snapshot for authorizing mutations. All commands still validate
server state and expected version. Gallery loads only while its panel is visible.

The map reuses geometry objects and completed segments. Persisted recorder GPS
samples can feed the rider marker; they do not create a second GPS watch or alter
stored coordinates. Nearby/presence checks keep their existing freshness limits.
Participants without a recording watch retain the one-shot fallback. Long changed
track segments still require full display smoothing; delta tracks remain a future
optimization rather than changing the stored route or its discontinuities.

Performance regression checks cover read coalescing, full post-response polling
intervals, identity fences, mutation invalidation, lazy private-image concurrency,
map geometry reuse and durable queue reconciliation. Measure device frame times
and slow-network behavior separately from raw bundle size before promising a
percentage reduction in user-visible latency.
