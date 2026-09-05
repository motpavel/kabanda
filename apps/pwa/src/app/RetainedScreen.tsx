import { useEffect, useState, type ReactNode } from 'react'

/** Keep visited UI (and decoded images) in the current identity's React tree. */
export function RetainedScreen({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active)
  useEffect(() => { if (active) setVisited(true) }, [active])
  return <div hidden={!active}>{(active || visited) ? children : null}</div>
}
