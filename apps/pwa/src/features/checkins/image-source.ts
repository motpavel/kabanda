export type DecodedImageSource = {
  source: CanvasImageSource
  width: number
  height: number
  release: () => void
}

async function decodeNativeImage(url: string, disposeUrl: () => void): Promise<DecodedImageSource> {
  const image = new Image()
  let released = false
  const release = () => {
    if (released) return
    released = true; image.onload = null; image.onerror = null; image.src = ''; disposeUrl()
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

/** Last-resort local read, not fetch(blob:). WebKit can reject its blob URL
 * loader while offline even though the selected File's bytes remain readable.
 * This never sends photo bytes anywhere, nor bypasses the canvas size/format
 * limits. The temporary string is released after the same native decoder. */
function selectedFileDataUrl(file: Blob): Promise<string> {
  if (file.size > 32 * 1024 * 1024) return Promise.reject(new TypeError('Image source too large'))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const cleanup = () => {
      clearTimeout(timer); reader.onload = null; reader.onerror = null; reader.onabort = null
    }
    const timer = setTimeout(() => {
      cleanup(); reader.abort(); reject(new TypeError('Image file read timed out'))
    }, 10_000)
    reader.onload = () => {
      const data = reader.result
      cleanup()
      if (typeof data !== 'string' || !/^data:image\/(?:jpeg|png|webp);base64,/.test(data)) {
        reject(new TypeError('Invalid image source')); return
      }
      resolve(data)
    }
    reader.onerror = reader.onabort = () => { cleanup(); reject(new TypeError('Image file unavailable')) }
    try { reader.readAsDataURL(file) } catch (error) { cleanup(); reject(error) }
  })
}

/** Optimized bitmap -> native blob URL -> local bytes. Decoding differences
 * must not require a network connection to save an otherwise valid photo. */
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
  try {
    const url = URL.createObjectURL(file)
    return await decodeNativeImage(url, () => URL.revokeObjectURL(url))
  } catch (error) {
    if (typeof FileReader === 'undefined') throw error
    return decodeNativeImage(await selectedFileDataUrl(file), () => {})
  }
}
