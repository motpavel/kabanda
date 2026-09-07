import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { experimentDb, summarizeExperiment, type ExperimentEvent } from './experiment-data'

const event = (kind: string, receivedAt: number, extra: Partial<ExperimentEvent> = {}): ExperimentEvent => ({
  id: crypto.randomUUID(), runId: 'test', kind, receivedAt, monotonicAt: receivedAt,
  visibility: 'visible', ...extra,
})
const hidden = event('visibility.hidden', 10_000, { visibility: 'hidden' })
const visible = event('visibility.visible', 200_000)

describe('GPS experiment evidence', () => {
  it('does not mistake a batch delivered after unlocking for background callbacks', () => {
    const delayed = event('gps.fix', 200_100, { capturedAt: 199_000, latitude: 1, longitude: 1 })
    const summary = summarizeExperiment([hidden, visible, delayed, { ...delayed, id: 'duplicate' }], 210_000)
    expect(summary.hiddenDurationMs).toBe(190_000)
    expect(summary.delayedFixes).toBe(2)
    expect(summary.freshHiddenFixes).toBe(0)
    expect(summary.uniqueFixCount).toBe(1)
    expect(summary.result).toBe('not-demonstrated')
  })
  it('distinguishes acquisition, receipt and storage completion', () => {
    const fix = event('gps.fix', 60_000, { visibility: 'hidden', capturedAt: 59_000, committedAt: 200_050, persistedVisibility: 'visible' })
    const summary = summarizeExperiment([hidden, visible, fix], 210_000)
    expect(summary.freshHiddenFixes).toBe(1)
    expect(summary.hiddenStorageWrites).toBe(0)
    expect(summary.result).toBe('hidden-fixes-observed')
  })
  it('does not count old or future fixes as fresh background positions', () => {
    const summary = summarizeExperiment([hidden, visible,
      event('gps.fix', 80_000, { visibility: 'hidden', capturedAt: 20_000 }),
      event('gps.fix', 90_000, { visibility: 'hidden', capturedAt: 999_000 }),
    ], 210_000)
    expect(summary.hiddenCallbacks).toBe(2)
    expect(summary.freshHiddenFixes).toBe(0)
  })
  it('does not classify a foreground fix delivered just after hiding as background acquisition', () => {
    const summary = summarizeExperiment([hidden, visible,
      event('gps.fix', 10_050, { visibility: 'hidden', capturedAt: 9_900 }),
    ], 210_000)
    expect(summary.hiddenCallbacks).toBe(1)
    expect(summary.freshHiddenFixes).toBe(0)
  })
  it('separates worker storage from GPS and ignores writes only acknowledged on resume', () => {
    const summary = summarizeExperiment([hidden, visible,
      event('worker.tick', 50_000, { visibility: 'worker', committedAt: 50_010 }),
      event('worker.tick', 60_000, { visibility: 'worker', committedAt: 200_050 }),
    ], 210_000)
    expect(summary.workerHiddenTicks).toBe(1)
    expect(summary.fixCount).toBe(0)
    expect(summary.result).toBe('not-demonstrated')
  })
  it('retains multiple hidden periods and identifies interrupted runs', () => {
    const summary = summarizeExperiment([hidden, visible, event('visibility.hidden', 220_000)], 230_000)
    expect(summary.intervals).toHaveLength(2)
    expect(summary.intervals[1].open).toBe(true)
    expect(summary.hiddenDurationMs).toBe(200_000)
    expect(summarizeExperiment([], 0).result).toBe('no-hidden-period')
  })
})

afterEach(async () => { await experimentDb.delete() })
it('keeps independent experiments and their raw timestamps after reopening storage', async () => {
  await experimentDb.open()
  await experimentDb.events.bulkAdd([event('gps.fix', 100, { id: 'a', runId: 'first', capturedAt: 10 }), event('gps.fix', 200, { id: 'b', runId: 'second', capturedAt: 150 })])
  experimentDb.close()
  await experimentDb.open()
  expect(await experimentDb.events.where('runId').equals('first').toArray()).toMatchObject([{ id: 'a', receivedAt: 100, capturedAt: 10 }])
  expect(await experimentDb.events.where('runId').equals('second').count()).toBe(1)
})
