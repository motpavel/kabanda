import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  processRaidTemplateCover,
  RaidTemplateCoverError,
} from '../src/raid-template-cover.js'

async function jpegDataUrl(width = 64, height = 36): Promise<string> {
  const bytes = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 35, g: 91, b: 61 },
    },
  }).jpeg().toBuffer()
  return `data:image/jpeg;base64,${bytes.toString('base64')}`
}

describe('raid template cover processing', () => {
  it('decodes and normalizes a bounded JPEG without retaining the data URL', async () => {
    const cover = await processRaidTemplateCover(await jpegDataUrl())

    expect(cover.contentType).toBe('image/jpeg')
    expect(cover.sizeBytes).toBe(cover.bytes.length)
    expect(cover.width).toBe(64)
    expect(cover.height).toBe(36)
    expect(cover.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(cover.bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  })

  it('rejects malformed base64 and a non-JPEG disguised by the data URL', async () => {
    await expect(
      processRaidTemplateCover('data:image/jpeg;base64,%%%'),
    ).rejects.toBeInstanceOf(RaidTemplateCoverError)

    const png = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    }).png().toBuffer()
    await expect(
      processRaidTemplateCover(`data:image/jpeg;base64,${png.toString('base64')}`),
    ).rejects.toMatchObject({ code: 'RAID_TEMPLATE_COVER_INVALID' })
  })

  it('rejects the transport before decoding when it exceeds the fixed bound', async () => {
    await expect(
      processRaidTemplateCover(`data:image/jpeg;base64,${'A'.repeat(420_000)}`),
    ).rejects.toMatchObject({ code: 'RAID_TEMPLATE_COVER_TOO_LARGE' })
  })
})
