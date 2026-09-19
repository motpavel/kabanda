const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
const READ_TIMEOUT_MS = 10_000

/** Materialize a bounded saved Blob before handing it to Fetch/Service Worker.
 * Network loaders need not retain access to the backing IndexedDB blob file
 * across page reloads. This reads the ORIGINAL bytes, never decodes/re-encodes
 * an image, changes its hash, or writes/deletes anything in the offline queue.
 * A local read failure remains retryable; it must not turn into a zero-byte PUT.
 */
export async function readPhotoUploadBody(blob: Blob): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(blob.size) || blob.size <= 0 || blob.size > MAX_UPLOAD_BYTES) {
    throw new TypeError('Saved photograph size is invalid')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const bytes = await Promise.race([
      blob.arrayBuffer(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TypeError('Saved photograph read timed out')), READ_TIMEOUT_MS)
      }),
    ])
    if (bytes.byteLength !== blob.size) throw new TypeError('Saved photograph bytes are incomplete')
    return bytes
  } finally { clearTimeout(timer) }
}
