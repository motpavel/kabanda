import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { KabandaSummary } from '../kabandas/types'
import { ProductionRaidsHub } from './ProductionRaidsHub'

const kabanda: KabandaSummary = {
  id: 'kabanda-real-id',
  name: 'Тестовая Кабанда',
  avatar: '🐗',
  coverImage: null,
  role: 'owner',
  memberCount: 2,
  pointsCollectionId: null,
}

describe('ProductionRaidsHub shell', () => {
  it('exposes the production selector and canonical owner create link without prototype fixtures', () => {
    const markup = renderToStaticMarkup(<ProductionRaidsHub identityId="owner-id" kabanda={kabanda} />)

    expect(markup).toContain('data-testid="production-raids-hub"')
    expect(markup).toContain('data-testid="production-new-raid"')
    expect(markup).toContain('href="/app?createRaid=kabanda-real-id"')
    expect(markup).not.toContain('Северное кольцо')
    expect(markup).not.toContain('Центр на закате')
  })

  it('does not offer the owner-only create action to a regular member', () => {
    const markup = renderToStaticMarkup(
      <ProductionRaidsHub identityId="member-id" kabanda={{ ...kabanda, role: 'member' }} />,
    )

    expect(markup).not.toContain('production-new-raid')
  })
})
