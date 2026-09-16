/** Run immediately after startup, retry without overlapping, drain before DB shutdown. */
export function startFinalizationWorker(
  sweep: () => Promise<unknown>,
  onError: (error: unknown) => void,
  intervalMs = 15_000,
): () => Promise<void> {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void>
  const run = async () => {
    try {
      await sweep()
    } catch (error) {
      onError(error)
    } finally {
      if (!stopped) {
        timer = setTimeout(() => { running = run() }, intervalMs)
        timer.unref()
      }
    }
  }
  running = run()
  return async () => {
    stopped = true
    clearTimeout(timer)
    await running
  }
}
