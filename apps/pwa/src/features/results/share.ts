export type ShareCardOutcome = 'shared' | 'downloaded'

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export async function shareResultCard(
  blob: Blob,
  title: string,
  filename = 'kabanda-result.png',
): Promise<ShareCardOutcome> {
  const file = typeof File === 'function' ? new File([blob], filename, { type: 'image/png' }) : null
  const data: ShareData = {
    title,
    text: 'Канонический итог рейда КАБАНДЫ',
    ...(file ? { files: [file] } : {}),
  }
  if (file && typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare(data)) {
    await navigator.share(data)
    return 'shared'
  }
  downloadBlob(blob, filename)
  return 'downloaded'
}
