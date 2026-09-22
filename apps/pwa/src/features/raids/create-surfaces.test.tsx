import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { KabandaSummary } from '../kabandas/types'
import { RaidHomeCreatePrompt } from './RaidHomeCard'

const membership: KabandaSummary = {
  id: 'kabanda-active',
  name: 'Кабанда',
  avatar: '🐗',
  coverImage: null,
  role: 'owner',
  memberCount: 2,
  pointsCollectionId: null,
}

describe('raid create surfaces', () => {
  it.each(['owner', 'member'] as const)('offers the home CTA to an active %s', (role) => {
    const markup = renderToStaticMarkup(
      <RaidHomeCreatePrompt enabled kabanda={{ ...membership, role }} />,
    )

    expect(markup).toContain('href="/app?createRaid=kabanda-active"')
    expect(markup).toContain('Создать рейд')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).not.toContain('Вожак ещё не открыл')
  })

  it('does not expose a create mutation from a stale home projection', () => {
    expect(renderToStaticMarkup(<RaidHomeCreatePrompt enabled={false} kabanda={membership} />)).toBe('')
  })

})
