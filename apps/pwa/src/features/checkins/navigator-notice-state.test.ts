import { describe, expect, it } from 'vitest'
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
    expect(tracker.observe(undefined)).toBe(null)
    expect(tracker.observe([point('old')])).toBe(null)
    expect(new NavigatorNoticeState('nav', 'raid', s).observe([point('old')])).toBe(null)
  })
  it('announces only a newly confirmed personal receipt for the navigator', () => {
    const t = new NavigatorNoticeState('nav', 'raid'); t.observe([point()])
    expect(t.observe([point(null, { pending: true })])).toBe(null)
    expect(t.observe([point(null, { status: 'sending', visitedByTeam: true })])).toBe(null)
    expect(t.observe([point('accepted')])?.myLastVisitAttemptId).toBe('accepted')
  })
  it('does not create success from proximity, photo, team-only or excluded membership', () => {
    const t = new NavigatorNoticeState('nav', 'raid'); t.observe([])
    expect(t.observe([point('a', { visitedByMe: false })])).toBe(null)
    expect(t.observe([point('a', { lastVisitParticipantIds: ['other'] })])).toBe(null)
    expect(t.observe([point('old', { lastAttemptId: 'new', lastVisitParticipantIds: ['other'] })])).toBe(null)
    expect(t.observe([point(null, { photos: 2, nearby: true })])).toBe(null)
  })
  it('never replays the same receipt on retry, poll, temporary empty list or older reads', () => {
    const t = new NavigatorNoticeState('nav', 'raid'); t.observe([point('old')])
    expect(t.observe([point('new')])).toBeTruthy()
    for (const rows of [[point('new')], [], [point('old')], [point('new')]]) expect(t.observe(rows)).toBe(null)
  })
  it('distinguishes a real repeat at the same point', () => {
    const t = new NavigatorNoticeState('nav', 'raid'); t.observe([])
    expect(t.observe([point('first')])).toBeTruthy()
    expect(t.observe([point('second')])).toBeTruthy()
    expect(t.observe([point('first')])).toBe(null)
  })
  it('persists deduplication across remount even when initial response regresses', () => {
    const s = storage(), t = new NavigatorNoticeState('nav', 'raid', s); t.observe([]); t.observe([point('new')])
    const reloaded = new NavigatorNoticeState('nav', 'raid', s)
    reloaded.observe([point('old')]); expect(reloaded.observe([point('new')])).toBe(null)
    expect(reloaded.observe([point('next')])).toBeTruthy()
  })
  it('isolates users and raids without touching other storage', () => {
    const s = storage(); s.values.set('outbox', 'unchanged')
    const a = new NavigatorNoticeState('nav', 'raid-a', s); a.observe([]); a.observe([point('a')])
    const b = new NavigatorNoticeState('nav', 'raid-b', s); b.observe([]); expect(b.observe([point('a')])).toBeTruthy()
    const c = new NavigatorNoticeState('other', 'raid-a', s); c.observe([])
    expect(c.observe([point('a', { lastVisitParticipantIds: ['other'] })])).toBeTruthy()
    expect(s.values.get('outbox')).toBe('unchanged')
  })
  it('tolerates corrupt/unavailable storage and never mutates frozen input', () => {
    for (const s of [{ getItem: () => '{broken', setItem: () => {} }, { getItem: () => { throw Error('denied') }, setItem: () => { throw Error('full') } }]) {
      const t = new NavigatorNoticeState('nav', 'raid', s); t.observe([])
      const rows = Object.freeze([Object.freeze(point('a'))]); const before = JSON.stringify(rows)
      expect(t.observe(rows)).toBeTruthy(); expect(t.observe(rows)).toBe(null); expect(JSON.stringify(rows)).toBe(before)
    }
  })
  it('resumes with a new baseline after losing navigator/active permission', () => {
    const t = new NavigatorNoticeState('nav', 'raid'); t.observe([]); t.suspend()
    expect(t.observe([point('during-suspension')])).toBe(null)
    expect(t.observe([point('after-resume')])).toBeTruthy()
  })
  it('coalesces a reconnect batch without replaying the other receipts later', () => {
    const t = new NavigatorNoticeState('nav', 'raid'); t.observe([])
    const rows = [point('a'), point('b', { id: 'second', lastVisitedAt: '2026-09-21T16:01:00Z' })]
    expect(t.observe(rows)?.id).toBe('second'); expect(t.observe(rows.reverse())).toBe(null)
  })
  it('bounds the presentation journal independently of GPS and photo queues', () => {
    const s = storage(), t = new NavigatorNoticeState('nav', 'raid', s); t.observe([])
    for (let i = 0; i < 1000; i++) t.observe([point(String(i))])
    expect(JSON.parse([...s.values.values()][0]!).length).toBe(256)
  })
})
