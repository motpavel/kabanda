import { db } from './db'
import type { CapabilitySnapshot, GpsSample } from './types'

export async function buildEvidenceBundle(sessionId: string, snapshot: CapabilitySnapshot) {
  const [session, samples, events, storage] = await Promise.all([
    db.sessions.get(sessionId),
    db.samples.where('sessionId').equals(sessionId).sortBy('capturedAt'),
    db.events.where('sessionId').equals(sessionId).sortBy('recordedAt'),
    navigator.storage?.estimate?.(),
  ])

  if (!session) throw new Error('Тестовая сессия не найдена')

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    session,
    capabilities: snapshot,
    storage: {
      usage: storage?.usage ?? null,
      quota: storage?.quota ?? null,
    },
    summary: {
      sampleCount: samples.length,
      eventCount: events.length,
      firstSampleAt: samples.at(0)?.capturedAt ?? null,
      lastSampleAt: samples.at(-1)?.capturedAt ?? null,
    },
    samples,
    events,
  }
}

export function buildGeoJson(samples: GpsSample[]) {
  return {
    type: 'FeatureCollection',
    features: samples.length
      ? [
          {
            type: 'Feature',
            properties: {
              sampleCount: samples.length,
              startedAt: samples.at(0)?.capturedAt,
              endedAt: samples.at(-1)?.capturedAt,
            },
            geometry: {
              type: 'LineString',
              coordinates: samples.map((sample) => [
                sample.longitude,
                sample.latitude,
                sample.altitude,
              ]),
            },
          },
        ]
      : [],
  }
}

export function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
