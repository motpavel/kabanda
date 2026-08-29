export interface ResultOperationAttempt<T> {
  fingerprint: string
  key: string
  payload: T
}

export function resultOperationStorageKey(
  kind: 'finish' | 'settle',
  identityId: string,
  raidId: string,
): string {
  return `kabanda:${kind}:${encodeURIComponent(identityId)}:${encodeURIComponent(raidId)}`
}

export function selectResultOperationAttempt<T>(
  current: ResultOperationAttempt<T> | null,
  fingerprint: string,
  payload: T,
  createKey: () => string = () => crypto.randomUUID(),
): ResultOperationAttempt<T> {
  return current?.fingerprint === fingerprint
    ? current
    : { fingerprint, key: createKey(), payload }
}

export function readResultOperationAttempt<T>(storageKey: string): ResultOperationAttempt<T> | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as Partial<ResultOperationAttempt<T>> | null
    return value && typeof value.fingerprint === 'string' && typeof value.key === 'string' && 'payload' in value
      ? value as ResultOperationAttempt<T>
      : null
  } catch {
    return null
  }
}

export function saveResultOperationAttempt<T>(storageKey: string, attempt: ResultOperationAttempt<T>): void {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(attempt))
  } catch {
    // The in-memory caller still keeps the exact attempt stable for this mount.
  }
}

export function clearResultOperationAttempt(storageKey: string, key: string): void {
  try {
    const current = readResultOperationAttempt(storageKey)
    if (current?.key === key) sessionStorage.removeItem(storageKey)
  } catch {
    // A canonical response is already sufficient; storage cleanup is best effort.
  }
}
