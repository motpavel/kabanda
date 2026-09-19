import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { RecorderPhase } from './types'

interface RecordingRuntimeValue {
  phase: RecorderPhase
  setPhase: (phase: RecorderPhase) => void
  unsyncedCheckInWork: number
  setUnsyncedCheckInWork: (count: number) => void
  setUnsyncedFieldWork: (count: number) => void
}
const RecordingRuntimeContext = createContext<RecordingRuntimeValue>({
  phase: 'ineligible', setPhase: () => undefined, unsyncedCheckInWork: 0,
  setUnsyncedCheckInWork: () => undefined, setUnsyncedFieldWork: () => undefined,
})
export function RecordingRuntimeProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<RecorderPhase>('ineligible')
  const [legacyPending, setUnsyncedCheckInWork] = useState(0)
  const [fieldPending, setUnsyncedFieldWork] = useState(0)
  // Independent producers must not overwrite each other's unsynced count.
  const value = useMemo(() => ({phase,setPhase,
    unsyncedCheckInWork:legacyPending+fieldPending,setUnsyncedCheckInWork,setUnsyncedFieldWork,
  }), [phase,legacyPending,fieldPending])
  return <RecordingRuntimeContext.Provider value={value}>{children}</RecordingRuntimeContext.Provider>
}
export function useRecordingRuntime() { return useContext(RecordingRuntimeContext) }
