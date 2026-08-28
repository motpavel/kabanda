export interface WatchIdRef {
  current: number | null
}

export async function resetGpsWatch(
  geolocation: Pick<Geolocation, 'clearWatch'>,
  watchIdRef: WatchIdRef,
  releaseWakeLock: () => Promise<void>,
) {
  const watchId = watchIdRef.current
  watchIdRef.current = null
  if (watchId !== null) geolocation.clearWatch(watchId)
  await releaseWakeLock()
}
