import { createHash } from 'node:crypto'
import sharp from 'sharp'

const jpegDataUrlPattern = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/
const maximumDataUrlLength = 420_000
const maximumInputPixels = 12_000_000
const maximumOutputBytes = 3 * 1024 * 1024

export class RaidTemplateCoverError extends Error {
  constructor(
    readonly code: 'RAID_TEMPLATE_COVER_INVALID' | 'RAID_TEMPLATE_COVER_TOO_LARGE',
    message: string,
  ) {
    super(message)
  }
}

export type ProcessedRaidTemplateCover = {
  bytes: Buffer
  contentType: 'image/jpeg'
  sizeBytes: number
  width: number
  height: number
  sha256: string
}

export async function processRaidTemplateCover(dataUrl: string): Promise<ProcessedRaidTemplateCover> {
  if (dataUrl.length > maximumDataUrlLength) {
    throw new RaidTemplateCoverError('RAID_TEMPLATE_COVER_TOO_LARGE', 'Обложка слишком большая')
  }
  const encoded = jpegDataUrlPattern.exec(dataUrl)?.[1]
  if (!encoded) {
    throw new RaidTemplateCoverError('RAID_TEMPLATE_COVER_INVALID', 'Нужна корректная JPEG-обложка')
  }

  const source = Buffer.from(encoded, 'base64')
  if (source.length === 0 || source.toString('base64') !== encoded) {
    throw new RaidTemplateCoverError('RAID_TEMPLATE_COVER_INVALID', 'Нужна корректная JPEG-обложка')
  }

  try {
    const image = sharp(source, { failOn: 'error', limitInputPixels: maximumInputPixels })
    const metadata = await image.metadata()
    if (
      metadata.format !== 'jpeg' ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 8_000 ||
      metadata.height > 8_000 ||
      metadata.width * metadata.height > maximumInputPixels
    ) {
      throw new RaidTemplateCoverError('RAID_TEMPLATE_COVER_INVALID', 'Нужна корректная JPEG-обложка')
    }

    const normalized = await image
      .rotate()
      .resize({ width: 2_048, height: 2_048, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true })
    const { width, height, size } = normalized.info
    if (!width || !height || size < 1 || size > maximumOutputBytes) {
      throw new RaidTemplateCoverError('RAID_TEMPLATE_COVER_TOO_LARGE', 'Обложка слишком большая')
    }
    return {
      bytes: normalized.data,
      contentType: 'image/jpeg',
      sizeBytes: size,
      width,
      height,
      sha256: createHash('sha256').update(normalized.data).digest('hex'),
    }
  } catch (error) {
    if (error instanceof RaidTemplateCoverError) throw error
    throw new RaidTemplateCoverError('RAID_TEMPLATE_COVER_INVALID', 'Нужна корректная JPEG-обложка')
  }
}
