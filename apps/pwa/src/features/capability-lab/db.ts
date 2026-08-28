import Dexie, { type EntityTable } from 'dexie'
import type {
  CapabilityEvent,
  CapabilitySession,
  CapabilitySetting,
  GpsSample,
} from './types'

class CapabilityDatabase extends Dexie {
  sessions!: EntityTable<CapabilitySession, 'id'>
  samples!: EntityTable<GpsSample, 'id'>
  events!: EntityTable<CapabilityEvent, 'id'>
  settings!: EntityTable<CapabilitySetting, 'key'>

  constructor() {
    super('kabanda-capability-lab')
    this.version(1).stores({
      sessions: 'id, startedAt, updatedAt',
      samples: 'id, sessionId, capturedAt, [sessionId+capturedAt]',
      events: 'id, sessionId, recordedAt, type, [sessionId+recordedAt]',
      settings: 'key',
    })
  }
}

export const db = new CapabilityDatabase()

export async function getOrCreateSession(displayMode: string): Promise<CapabilitySession> {
  const active = await db.settings.get('activeSessionId')
  if (active) {
    const session = await db.sessions.get(active.value)
    if (session && !session.endedAt) return session
  }

  const now = new Date().toISOString()
  const session: CapabilitySession = {
    id: crypto.randomUUID(),
    label: `Полевой тест ${new Date().toLocaleDateString('ru-RU')}`,
    startedAt: now,
    updatedAt: now,
    userAgent: navigator.userAgent,
    displayMode,
    notes: '',
    appVersion: __APP_VERSION__,
  }

  await db.transaction('rw', db.sessions, db.settings, async () => {
    await db.sessions.add(session)
    await db.settings.put({ key: 'activeSessionId', value: session.id })
  })

  return session
}

export async function appendEvent(
  sessionId: string,
  type: string,
  detail: CapabilityEvent['detail'] = {},
): Promise<CapabilityEvent> {
  const event: CapabilityEvent = {
    id: crypto.randomUUID(),
    sessionId,
    recordedAt: new Date().toISOString(),
    type,
    detail,
  }
  await db.events.add(event)
  return event
}

