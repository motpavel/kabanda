/** Keep the file input's selection alive while the browser consumes its File.
 * Clearing it before an async decoder/reader finishes can revoke a native file
 * backing store. Reset afterwards so choosing the same file again still works.
 * Never clear a newer selection that arrived while the older one was processed. */
export async function consumeSelectedFile(
  input: Pick<HTMLInputElement, 'files' | 'value'>,
  consume: (file: File) => Promise<unknown>,
): Promise<void> {
  const selected = input.files?.[0]
  if (!selected) return
  try { await consume(selected) }
  finally { if (input.files?.[0] === selected) input.value = '' }
}
