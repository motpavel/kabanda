import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { RecorderPhase } from './types'

interface RecordingRuntimeValue {
  phase: RecorderPhase
  setPhase: (phase: RecorderPhase) => void
  unsyncedCheckInWork: number
  setUnsyncedCheckInWork: (count: number) => void
}

const RecordingRuntimeContext = createContext<RecordingRuntimeValue>({
  phase: 'ineligible',
  setPhase: () => undefined,
  unsyncedCheckInWork: 0,
  setUnsyncedCheckInWork: () => undefined,
})

export function RecordingRuntimeProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<RecorderPhase>('ineligible')
  const [unsyncedCheckInWork, setUnsyncedCheckInWork] = useState(0)
  const value = useMemo(
    () => ({ phase, setPhase, unsyncedCheckInWork, setUnsyncedCheckInWork }),
    [phase, unsyncedCheckInWork],
  )
  return <RecordingRuntimeContext.Provider value={value}>{children}</RecordingRuntimeContext.Provider>
}

export function useRecordingRuntime() {
  return useContext(RecordingRuntimeContext)
}
