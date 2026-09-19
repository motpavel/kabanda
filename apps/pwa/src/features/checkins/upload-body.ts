const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
const READ_TIMEOUT_MS = 10_000

/** Read the original local bytes only. Some WebKit saved-Blob handles reject
 * arrayBuffer() while FileReader can still resolve their local backing file.
 * A fallback is permitted only for a local not-found/not-readable failure, not
 * for a security denial. Both paths share one deadline and never touch storage.
 * A failed read remains retryable; it must not turn into an empty/reencoded PUT.
 */
export async function readPhotoUploadBody(blob: Blob): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(blob.size) || blob.size <= 0 || blob.size > MAX_UPLOAD_BYTES) {
    throw new TypeError('Saved photograph size is invalid')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let reader: FileReader | undefined
  const read = async (): Promise<ArrayBuffer> => {
    try { return await blob.arrayBuffer() }
    catch (error) {
      const name = error instanceof Error || error instanceof DOMException ? error.name : ''
      if (!['NotFoundError', 'NotReadableError'].includes(name) || typeof FileReader === 'undefined') throw error
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const current = reader = new FileReader()
        current.onload = () => {
          if (current.result instanceof ArrayBuffer) resolve(current.result)
          else reject(new TypeError('Saved photograph bytes are incomplete'))
        }
        current.onerror = () => reject(current.error ?? new TypeError('Saved photograph is unavailable'))
        current.onabort = () => reject(new TypeError('Saved photograph read interrupted'))
        try { current.readAsArrayBuffer(blob) } catch (reason) { reject(reason) }
      })
    }
  }
  try {
    const bytes = await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TypeError('Saved photograph read timed out')), READ_TIMEOUT_MS)
      }),
    ])
    if (bytes.byteLength !== blob.size) throw new TypeError('Saved photograph bytes are incomplete')
    return bytes
  } finally {
    clearTimeout(timer)
    if (reader) {
      reader.onload = null; reader.onerror = null; reader.onabort = null
      if (reader.readyState === 1) reader.abort()
    }
  }
}
