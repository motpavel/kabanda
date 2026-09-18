import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TeamMetric } from './KabandasPage'

describe('unknown team metrics', () => {
  it('does not present an unknown metric as zero', () => {
    const html = renderToStaticMarkup(<TeamMetric icon="bike" label="рейдов" value={null} />)
    expect(html).toContain('Данные ещё не получены')
    expect(html).toContain('>…</strong>')
    expect(html).not.toContain('>0</strong>')
  })
  it('still renders a confirmed zero and a known positive value', () => {
    expect(renderToStaticMarkup(<TeamMetric icon="bike" label="рейдов" value={0} />)).toContain('>0</strong>')
    expect(renderToStaticMarkup(<TeamMetric icon="bike" label="рейдов" value={12} />)).toContain('>12</strong>')
  })
})
