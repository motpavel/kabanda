import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { NavigatorNoticeState } from './navigator-notice-state'
const point = (attempt: string | null = null, extra = {}) => ({ id: 'point', visitedByMe: Boolean(attempt),
  myLastVisitAttemptId: attempt, lastAttemptId: attempt, lastVisitParticipantIds: attempt ? ['nav'] : [],
  lastVisitedAt: '2026-09-21T16:00:00Z', ...extra })
function storage() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}
describe('navigator confirmation notices', () => {
  it('does not celebrate initial history, including first load and reload', () => {
    const s = storage(), tracker = new NavigatorNoticeState('nav', 'raid', s)
    assert.equal(tracker.observe(undefined), null)
    assert.equal(tracker.observe([point('old')]), null)
    assert.equal(new NavigatorNoticeState('nav', 'raid', s).observe([point('old')]), null)
  })
  it('announces only a newly confirmed personal receipt for the navigator', () => {
    const t = new NavigatorNoticeState('nav', 'raid'); t.observe([point()])
    assert.equal(t.observe([point(null, { pending: true })]), null)
    assert.equal(t.observe([point(null, { status: 'sending', visitedByTeam: true })]), null)
    assert.equal(t.observe([point('accepted')])?.myLastVisitAttemptId, 'accepted')
  })
  it('does not create success from proximity, photo, team-only or excluded membership', () => {
    const t = new NavigatorNoticeState('nav', 'raid'); t.observe([])
    assert.equal(t.observe([point('a', { visitedByMe: false })]), null)
    assert.equal(t.observe([point('a', { lastVisitParticipantIds: ['other'] })]), null)
    assert.equal(t.observe([point('old', { lastAttemptId: 'new', lastVisitParticipantIds: ['other'] })]), null)
    assert.equal(t.observe([point(null, { photos: 2, nearby: true })]), null)
  })
  it('never replays the same receipt on retry, poll, temporary empty list or older reads', () => {
    const t = new NavigatorNoticeState('nav', 'raid'); t.observe([point('old')])
    assert.ok(t.observe([point('new')]))
    for (const rows of [[point('new')], [], [point('old')], [point('new')]]) assert.equal(t.observe(rows), null)
  })
  it('distinguishes a real repeat at the same point', () => {
    const t = new NavigatorNoticeState('nav', 'raid'); t.observe([])
    assert.ok(t.observe([point('first')]))
    assert.ok(t.observe([point('second')]))
    assert.equal(t.observe([point('first')]), null)
  })
  it('persists deduplication across remount even when initial response regresses', () => {
    const s = storage(), t = new NavigatorNoticeState('nav', 'raid', s); t.observe([]); t.observe([point('new')])
    const reloaded = new NavigatorNoticeState('nav', 'raid', s)
    reloaded.observe([point('old')]); assert.equal(reloaded.observe([point('new')]), null)
    assert.ok(reloaded.observe([point('next')]))
  })
  it('isolates users and raids without touching other storage', () => {
    const s = storage(); s.values.set('outbox', 'unchanged')
    const a = new NavigatorNoticeState('nav', 'raid-a', s); a.observe([]); a.observe([point('a')])
    const b = new NavigatorNoticeState('nav', 'raid-b', s); b.observe([]); assert.ok(b.observe([point('a')]))
    const c = new NavigatorNoticeState('other', 'raid-a', s); c.observe([])
    assert.ok(c.observe([point('a', { lastVisitParticipantIds: ['other'] })]))
    assert.equal(s.values.get('outbox'), 'unchanged')
  })
  it('tolerates corrupt/unavailable storage and never mutates frozen input', () => {
    for (const s of [{ getItem: () => '{broken', setItem: () => {} }, { getItem: () => { throw Error('denied') }, setItem: () => { throw Error('full') } }]) {
      const t = new NavigatorNoticeState('nav', 'raid', s); t.observe([])
      const rows = Object.freeze([Object.freeze(point('a'))]); const before = JSON.stringify(rows)
      assert.ok(t.observe(rows)); assert.equal(t.observe(rows), null); assert.equal(JSON.stringify(rows), before)
    }
  })
  it('resumes with a new baseline after losing navigator/active permission', () => {
    const t = new NavigatorNoticeState('nav', 'raid'); t.observe([]); t.suspend()
    assert.equal(t.observe([point('during-suspension')]), null)
    assert.ok(t.observe([point('after-resume')]))
  })
  it('coalesces a reconnect batch without replaying the other receipts later', () => {
    const t = new NavigatorNoticeState('nav', 'raid'); t.observe([])
    const rows = [point('a'), point('b', { id: 'second', lastVisitedAt: '2026-09-21T16:01:00Z' })]
    assert.equal(t.observe(rows)?.id, 'second'); assert.equal(t.observe(rows.reverse()), null)
  })
  it('bounds the presentation journal independently of GPS and photo queues', () => {
    const s = storage(), t = new NavigatorNoticeState('nav', 'raid', s); t.observe([])
    for (let i = 0; i < 1000; i++) t.observe([point(String(i))])
    assert.equal(JSON.parse([...s.values.values()][0]!).length, 256)
  })
})
