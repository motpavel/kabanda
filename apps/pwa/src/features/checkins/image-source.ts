export type DecodedImageSource = {
  source: CanvasImageSource
  width: number
  height: number
  release: () => void
}

/** Resize during decoding when supported, but do not reject a valid photograph
 * solely because an engine rejects ImageBitmap/resize options. Both paths still
 * pass through the same bounded canvas encoder and durable queue afterwards. */
export async function decodeImageSource(file: Blob): Promise<DecodedImageSource> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: 2048, resizeQuality: 'high' })
      if (bitmap.width > 0 && bitmap.height > 0) return {
        source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close(),
      }
      bitmap.close()
    } catch { /* Native image decoding below supports the same selected file. */ }
  }
  if (typeof Image === 'undefined') throw new TypeError('Image decoding unavailable')
  const url = URL.createObjectURL(file)
  const image = new Image()
  let released = false
  const release = () => {
    if (released) return
    released = true; image.onload = null; image.onerror = null; image.src = ''; URL.revokeObjectURL(url)
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { image.onload = null; image.onerror = null; reject(new TypeError('Image decoding timed out')) }, 10_000)
      image.onload = () => {
        clearTimeout(timer)
        if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve()
        else reject(new TypeError('Empty image'))
      }
      image.onerror = () => { clearTimeout(timer); reject(new TypeError('Invalid image')) }
      image.decoding = 'async'
      image.src = url
    })
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, release }
  } catch (error) { release(); throw error }
}
