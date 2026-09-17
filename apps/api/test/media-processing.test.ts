import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { processMedia } from '../src/raids.js'

async function image(format: 'gif' | 'tiff' | 'jpeg'): Promise<Buffer> {
  const source = sharp({
    create: { width: 8, height: 8, channels: 3, background: '#7a3e18' },
  })
  if (format === 'gif') return source.gif().toBuffer()
  if (format === 'tiff') return source.tiff().toBuffer()
  return source.jpeg().toBuffer()
}

describe('untrusted media processing', () => {
  it.each(['gif', 'tiff'] as const)('rejects blocked %s loaders', async (format) => {
    await expect(processMedia(await image(format), 'image/png')).rejects.toMatchObject({
      code: 'MEDIA_INVALID',
      statusCode: 400,
    })
  })

  it.each([[4032, 3024], [8064, 6048]])('accepts a %i × %i phone photo and downsizes it', async (width, height) => {
    const bytes = await sharp({ create: { width, height, channels: 3, background: '#7a3e18' } }).jpeg().toBuffer()
    const result = await processMedia(bytes, 'image/jpeg')
    expect(result.info.width).toBeLessThanOrEqual(2048)
    expect(result.info.height).toBeLessThanOrEqual(2048)
    expect(result.data.byteLength).toBeLessThan(3 * 1024 * 1024)
  })

  it('rejects disguised and malformed bytes with a bounded domain error', async () => {
    await expect(processMedia(await image('jpeg'), 'image/png')).rejects.toMatchObject({
      code: 'MEDIA_INVALID',
      statusCode: 400,
    })
    await expect(processMedia(Buffer.from('VIPS-not-an-image'), 'image/webp')).rejects.toMatchObject({
      code: 'MEDIA_INVALID',
      statusCode: 400,
    })
  })
})
