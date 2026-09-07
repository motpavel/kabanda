import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { experimentDb, summarizeExperiment, type ExperimentEvent, type ExperimentRun } from './experiment-data'

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
    expect(summary.confirmedHiddenFixes).toBe(0)
    expect(summary.sustainedHiddenFixes).toBe(0)
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
  it('keeps media events and page writes separate from GPS evidence', () => {
    const summary = summarizeExperiment([hidden, visible,
      event('audio.timeupdate', 80_000, { visibility: 'hidden', committedAt: 80_010, persistedVisibility: 'hidden' }),
      event('page.tick', 80_100, { visibility: 'hidden', committedAt: 80_110, persistedVisibility: 'hidden' }),
      event('audio.error', 80_200, { visibility: 'hidden', detail: 'Playback failed' }),
    ], 210_000)
    expect(summary.audioHiddenEvents).toBe(1)
    expect(summary.audioErrors).toBe(1)
    expect(summary.errors).toBe(0)
    expect(summary.pageHiddenTicks).toBe(1)
    expect(summary.pageHiddenWrites).toBe(1)
    expect(summary.freshHiddenFixes).toBe(0)
    expect(summary.confirmedHiddenFixes).toBe(0)
    expect(summary.sustainedHiddenFixes).toBe(0)
    expect(summary.result).toBe('not-demonstrated')
  })
  it.each(['audio.timeupdate', 'page.tick', 'gps.fix'])('does not confirm %s committed on return or in another hidden period', kind => {
    const summary = summarizeExperiment([hidden, visible,
      event('visibility.hidden', 220_000, { visibility: 'hidden' }),
      event(kind, 80_000, { visibility: 'hidden', capturedAt: 79_000, committedAt: 200_000, persistedVisibility: 'hidden' }),
      event(kind, 81_000, { visibility: 'hidden', capturedAt: 80_000, committedAt: 220_100, persistedVisibility: 'hidden' }),
      event(kind, 82_000, { visibility: 'hidden', capturedAt: 81_000, committedAt: 82_100, persistedVisibility: 'visible' }),
    ], 230_000)
    expect(summary.audioHiddenEvents).toBe(0)
    expect(summary.pageHiddenWrites).toBe(0)
    expect(summary.confirmedHiddenFixes).toBe(0)
    expect(summary.sustainedHiddenFixes).toBe(0)
    if (kind === 'page.tick') expect(summary.pageHiddenTicks).toBe(3)
  })
  it('counts fresh, independently captured GPS persisted at least a minute into the same hidden period', () => {
    const summary = summarizeExperiment([hidden, visible,
      event('gps.fix', 20_100, { visibility: 'hidden', capturedAt: 20_000, committedAt: 20_110, persistedVisibility: 'hidden' }),
      event('gps.fix', 70_100, { visibility: 'hidden', capturedAt: 70_000, committedAt: 70_110, persistedVisibility: 'hidden' }),
      event('gps.fix', 85_100, { visibility: 'hidden', capturedAt: 85_000, committedAt: 85_110, persistedVisibility: 'hidden' }),
    ], 210_000)
    expect(summary.freshHiddenFixes).toBe(3)
    expect(summary.confirmedHiddenFixes).toBe(3)
    expect(summary.sustainedHiddenFixes).toBe(2)
  })
  it('requires capture and receipt to be beyond the minute boundary, not only storage', () => {
    const summary = summarizeExperiment([hidden, visible,
      event('gps.fix', 70_100, { visibility: 'hidden', capturedAt: 69_999, committedAt: 70_110, persistedVisibility: 'hidden' }),
      event('gps.fix', 69_999, { visibility: 'hidden', capturedAt: 70_000, committedAt: 70_110, persistedVisibility: 'hidden' }),
    ], 210_000)
    expect(summary.confirmedHiddenFixes).toBe(2)
    expect(summary.sustainedHiddenFixes).toBe(0)
  })
  it('never promotes a later duplicate over the first callback whose write completed after resume', () => {
    const first = event('gps.fix', 80_000, { visibility: 'hidden', capturedAt: 79_000, latitude: 1, longitude: 1, committedAt: 200_100, persistedVisibility: 'visible' })
    const duplicate = { ...first, id: 'later-duplicate', receivedAt: 80_100, committedAt: 80_110, persistedVisibility: 'hidden' as const }
    const summary = summarizeExperiment([hidden, visible, duplicate, first], 210_000)
    expect(summary.fixCount).toBe(2)
    expect(summary.uniqueFixCount).toBe(1)
    expect(summary.freshHiddenFixes).toBe(1)
    expect(summary.confirmedHiddenFixes).toBe(0)
    expect(summary.sustainedHiddenFixes).toBe(0)
  })
  it('counts a duplicate fresh GPS fix once even if both callbacks were persisted in the background', () => {
    const first = event('gps.fix', 80_000, { visibility: 'hidden', capturedAt: 79_000, latitude: 1, longitude: 1, committedAt: 80_010, persistedVisibility: 'hidden' })
    const duplicate = { ...first, id: 'duplicate', receivedAt: 80_100, committedAt: 80_110 }
    const summary = summarizeExperiment([hidden, visible, duplicate, first], 210_000)
    expect(summary.confirmedHiddenFixes).toBe(1)
    expect(summary.sustainedHiddenFixes).toBe(1)
  })
  it('does not confirm older stored runs without storage acknowledgements', () => {
    const summary = summarizeExperiment([hidden, visible,
      event('gps.fix', 80_000, { visibility: 'hidden', capturedAt: 79_000 }),
      event('page.tick', 80_100, { visibility: 'hidden' }),
    ], 210_000)
    expect(summary.freshHiddenFixes).toBe(1)
    expect(summary.pageHiddenTicks).toBe(1)
    expect(summary.pageHiddenWrites).toBe(0)
    expect(summary.confirmedHiddenFixes).toBe(0)
    expect(summary.sustainedHiddenFixes).toBe(0)
    expect(summary.audioHiddenEvents).toBe(0)
    expect(summary.audioErrors).toBe(0)
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
  const run: ExperimentRun = { id: 'first', startedAt: 0, mode: 'watch', keepScreen: true, displayMode: 'standalone', userAgent: 'test', version: 'old', persisted: null }
  await experimentDb.runs.bulkAdd([run, { ...run, id: 'second', mode: 'audio', version: 'new' }])
  await experimentDb.events.bulkAdd([event('gps.fix', 100, { id: 'a', runId: 'first', capturedAt: 10 }), event('gps.fix', 200, { id: 'b', runId: 'second', capturedAt: 150 })])
  experimentDb.close()
  await experimentDb.open()
  expect(await experimentDb.events.where('runId').equals('first').toArray()).toMatchObject([{ id: 'a', receivedAt: 100, capturedAt: 10 }])
  expect(await experimentDb.events.where('runId').equals('second').count()).toBe(1)
  expect(await experimentDb.runs.get('first')).toEqual(run)
  expect(await experimentDb.runs.get('second')).toMatchObject({ mode: 'audio', version: 'new' })
  expect(experimentDb.name).toBe('kabanda-gps-experiments-v2')
  expect(experimentDb.verno).toBe(1)
})
