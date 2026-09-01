import { useEffect, useMemo, useState } from 'react'
import { routeDistance, splitRouteAtDistance, type RouteCoordinate } from './simulation'

const FRAME_COUNT = 30
const FRAME_DELAY_MS = 680

export function useRoutePlayback(route: readonly RouteCoordinate[]) {
  const [sampleIndex, setSampleIndex] = useState(0)

  useEffect(() => setSampleIndex(0), [route])

  useEffect(() => {
    if (route.length < 2) return
    const timer = window.setTimeout(() => {
      setSampleIndex((current) => current >= FRAME_COUNT ? 0 : current + 1)
    }, sampleIndex >= FRAME_COUNT ? 1_800 : FRAME_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [route, sampleIndex])

  const totalDistanceM = useMemo(() => routeDistance(route), [route])
  const progress = Math.min(1, sampleIndex / FRAME_COUNT)
  const traveledDistanceM = totalDistanceM * progress
  const split = useMemo(
    () => splitRouteAtDistance(route, traveledDistanceM),
    [route, traveledDistanceM],
  )
  return {
    current: split.current,
    traveled: split.traveled,
  }
}
