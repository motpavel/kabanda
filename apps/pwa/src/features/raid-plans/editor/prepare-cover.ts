const ACCEPTED_COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_SOURCE_BYTES = 12 * 1024 * 1024
const MAX_DATA_URL_LENGTH = 420_000

export async function prepareRaidTemplateCover(file: File): Promise<string> {
  if (!ACCEPTED_COVER_TYPES.includes(file.type)) throw new Error('Выберите JPEG, PNG или WebP.')
  if (file.size > MAX_SOURCE_BYTES) throw new Error('Файл больше 12 МБ. Выберите изображение поменьше.')

  const sourceUrl = URL.createObjectURL(file)
  try {
    const image = await loadImage(sourceUrl)
    const ratio = 16 / 9
    const width = Math.min(1280, image.naturalWidth)
    const height = Math.max(1, Math.round(width / ratio))
    const sourceRatio = image.naturalWidth / image.naturalHeight
    const sourceWidth = sourceRatio > ratio ? image.naturalHeight * ratio : image.naturalWidth
    const sourceHeight = sourceRatio > ratio ? image.naturalHeight : image.naturalWidth / ratio
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Не удалось подготовить изображение на этом устройстве.')
    context.drawImage(
      image,
      (image.naturalWidth - sourceWidth) / 2,
      (image.naturalHeight - sourceHeight) / 2,
      sourceWidth,
      sourceHeight,
      0,
      0,
      width,
      height,
    )
    for (const quality of [0.8, 0.68, 0.56, 0.44]) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality)
      if (dataUrl.length <= MAX_DATA_URL_LENGTH) return dataUrl
    }
    throw new Error('Изображение не удалось сжать. Выберите другое.')
  } finally {
    URL.revokeObjectURL(sourceUrl)
  }
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Файл не похож на исправное изображение.'))
    image.src = source
  })
}
