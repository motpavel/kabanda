import sharp from 'sharp'
import type { RaidResult } from './raids.js'

export function escapeShareCardXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

export function shareTitleLines(title: string): string[] {
  const words = title.trim().toLocaleUpperCase('ru-RU').split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    for (const chunk of word.match(/.{1,25}/gu) ?? []) {
      if (line && `${line} ${chunk}`.length > 25) { lines.push(line); line = '' }
      line = line ? `${line} ${chunk}` : chunk
    }
  }
  if (line) lines.push(line)
  if (lines.length > 3) return [...lines.slice(0, 2), `${lines[2]!.slice(0, 23)}…`]
  return lines.length ? lines : ['ГОРОДСКОЙ РЕЙД']
}

export async function renderRaidShareCard(result: RaidResult): Promise<Buffer> {
  const titles = shareTitleLines(result.raid.title)
  const titleWidths = await Promise.all(titles.map(async (line) => {
    const { info } = await sharp({ text: { text: escapeShareCardXml(line), font: 'DejaVu Sans Bold 58', rgba: true } }).png().toBuffer({ resolveWithObject: true })
    return info.width
  }))
  const titleSize = Math.min(58, Math.floor(58 * 960 / Math.max(...titleWidths, 1)))
  const date = new Date(result.raid.completedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Samara' })
  const totalMinutes = Math.round(result.team.durationSeconds / 60)
  const duration = totalMinutes >= 60 ? `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, '0')}` : `${totalMinutes}`
  const metrics = [
    { x: 60, value: (result.team.distanceMeters / 1000).toFixed(1).replace('.', ','), unit: 'КИЛОМЕТРОВ' },
    { x: 330, value: duration, unit: totalMinutes >= 60 ? 'ЧАСЫ : МИНУТЫ' : 'МИНУТ' },
    { x: 620, value: String(result.team.uniquePoints), unit: 'ТОЧЕК' },
    { x: 855, value: String(result.participants.length), unit: 'В КОМАНДЕ' },
  ]
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350">
    <g font-family="DejaVu Sans, sans-serif" fill="#202522">
      <text x="60" y="74" fill="#d93a27" font-size="21" font-weight="700" letter-spacing="3">${result.raid.partial ? 'РЕЙД ЗАВЕРШЁН · НЕПОЛНЫЙ ИТОГ' : 'РЕЙД ЗАВЕРШЁН'}</text>
      ${titles.map((line, index) => `<text x="56" y="${164 + index * 72}" font-size="${titleSize}" font-weight="700" letter-spacing="-2">${escapeShareCardXml(line)}</text>`).join('')}
      <text x="60" y="360" font-size="24" fill="#5d635d">${escapeShareCardXml(date)}</text>
      <path d="M60 1100h960" stroke="#202522" stroke-opacity=".22"/>
      ${metrics.map(({x,value,unit}) => `<text x="${x}" y="1185" font-size="60" font-weight="700" letter-spacing="-2">${value}</text><text x="${x}" y="1225" font-size="17" font-weight="700" letter-spacing="1">${unit}</text>`).join('')}
      <text x="60" y="1310" font-size="18" font-weight="700" letter-spacing="3">БОЛЬШЕ, ЧЕМ КИЛОМЕТРЫ.</text>
    </g>
  </svg>`)
  const wordmark = await sharp(new URL('../../pwa/public/brand/kabanda-wordmark.png', import.meta.url).pathname).resize(205,78,{fit:'inside'}).png().toBuffer()
  return sharp(new URL('../../pwa/public/brand/raid-share-art-v1.jpg', import.meta.url).pathname)
    .resize(1080,1350)
    .composite([{ input: svg }, { input: wordmark, left: 815, top: 25 }])
    .png({ compressionLevel: 9, palette: true, colours: 256, dither: .4 })
    .toBuffer()
}
