import { RouteSimulationMap } from './RouteSimulationMap'
import { useRoutePlayback } from './useRoutePlayback'

export function CleanMapVariant() {
  const playback = useRoutePlayback()
  return (
    <main className="route-proto route-proto--clean">
      <RouteSimulationMap traveled={playback.traveled} followMode />
    </main>
  )
}
