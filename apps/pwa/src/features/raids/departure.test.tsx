import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RaidModePicker, departureTitle } from './RaidModePicker'
import { normalizeCreateRaidPayload, restoreCreateRaidForm, selectCreateRaidAttempt } from './createAttempt'
import { isInternalAppLink } from '../../app/transitions'

describe('departure flow', () => {
  it('offers exactly two illustrated modes without an upfront name form', () => {
    const html = renderToStaticMarkup(<RaidModePicker onSelect={() => undefined} />)
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html).toContain('kabanda-free-hunt-v1.jpg')
    expect(html).toContain('kabanda-route-raid-v1.jpg')
    expect(html).not.toContain('<input')
  })
  it('names the actual departure date without asking for a title', () => {
    expect(departureTitle('free', undefined, new Date(2026, 8, 5, 15))).toBe('Свободный рейд · 5 сентября')
    expect(departureTitle('route', 'Вокруг пруда', new Date(2026, 8, 6, 15))).toBe('Вокруг пруда · 6 сентября')
  })
  it('restores category and meeting place and preserves the retry key', () => {
    const payload = normalizeCreateRaidPayload({ title: 'Свободный рейд · 5 сентября', description: 'Берём воду', scheduledAt: null, pointCategory: 'stores', meetingPlace: 'Вход в парк' })
    const attempt = selectCreateRaidAttempt(null, 'user', 'team', payload, 'first-key')
    expect(selectCreateRaidAttempt(attempt, 'user', 'team', payload, 'new-key').key).toBe('first-key')
    expect(restoreCreateRaidForm(attempt, 'user', 'team')).toMatchObject({ pointCategory: 'stores', meetingPlace: 'Вход в парк', description: 'Берём воду' })
    const changed = payload.replace('stores', 'attractions')
    expect(selectCreateRaidAttempt(attempt, 'user', 'team', changed, 'new-key').key).toBe('new-key')
  })
  it('does not hijack authentication, external links or fragment navigation', () => {
    const origin = 'https://kabanda.example'
    expect(isInternalAppLink(new URL(`${origin}/app?createRaid=team`), origin, '/app')).toBe(true)
    expect(isInternalAppLink(new URL(`${origin}/auth/verify?token=x`), origin, '/app')).toBe(false)
    expect(isInternalAppLink(new URL('https://other.example/app'), origin, '/app')).toBe(false)
    expect(isInternalAppLink(new URL(`${origin}/app#target`), origin, '/app')).toBe(false)
  })
})
