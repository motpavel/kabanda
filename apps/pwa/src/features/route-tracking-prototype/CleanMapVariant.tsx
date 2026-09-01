import { RouteSimulationMap } from './RouteSimulationMap'
import { TEST_ROUTE } from './simulation'
import { useRoutePlayback } from './useRoutePlayback'

export function CleanMapVariant() {
  const playback = useRoutePlayback(TEST_ROUTE)

  return (
    <main className="route-proto route-proto--clean">
      <RouteSimulationMap
        current={playback.current}
        traveled={playback.traveled}
      />
    </main>
  )
}
