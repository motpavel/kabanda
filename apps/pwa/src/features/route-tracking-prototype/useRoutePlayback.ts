import { useEffect, useMemo, useState } from 'react'
import { routeDistance, TEST_ROUTE, TEST_ROUTE_DISTANCE_M } from './simulation'

export function useRoutePlayback() {
  const [sampleIndex, setSampleIndex] = useState(0)
  const [playing, setPlaying] = useState(true)

  useEffect(() => {
    if (!playing || sampleIndex >= TEST_ROUTE.length - 1) return
    const timer = window.setTimeout(() => {
      setSampleIndex((current) => Math.min(current + 1, TEST_ROUTE.length - 1))
    }, 720)
    return () => window.clearTimeout(timer)
  }, [playing, sampleIndex])

  const traveled = useMemo(() => TEST_ROUTE.slice(0, sampleIndex + 1), [sampleIndex])
  const traveledDistanceM = useMemo(() => routeDistance(traveled), [traveled])
  const completed = sampleIndex === TEST_ROUTE.length - 1

  return {
    completed,
    playing: playing && !completed,
    progress: TEST_ROUTE_DISTANCE_M ? traveledDistanceM / TEST_ROUTE_DISTANCE_M : 0,
    remainingDistanceM: Math.max(0, TEST_ROUTE_DISTANCE_M - traveledDistanceM),
    sampleIndex,
    speedKmh: completed ? 0 : 17 + (sampleIndex % 5),
    traveled,
    traveledDistanceM,
    toggle() {
      if (completed) {
        setSampleIndex(0)
        setPlaying(true)
        return
      }
      setPlaying((current) => !current)
    },
    restart() {
      setSampleIndex(0)
      setPlaying(true)
    },
  }
}
