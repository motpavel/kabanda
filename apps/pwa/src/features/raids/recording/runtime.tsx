import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { RecorderPhase } from './types'

interface RecordingRuntimeValue {
  phase: RecorderPhase
  setPhase: (phase: RecorderPhase) => void
}

const RecordingRuntimeContext = createContext<RecordingRuntimeValue>({
  phase: 'ineligible',
  setPhase: () => undefined,
})

export function RecordingRuntimeProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<RecorderPhase>('ineligible')
  const value = useMemo(() => ({ phase, setPhase }), [phase])
  return <RecordingRuntimeContext.Provider value={value}>{children}</RecordingRuntimeContext.Provider>
}

export function useRecordingRuntime() {
  return useContext(RecordingRuntimeContext)
}
