export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  const body = response.status === 204 ? null : await response.json()
  if (!response.ok) {
    const error = body?.error
    throw new ApiError(error?.code ?? 'REQUEST_FAILED', error?.message ?? 'Ошибка запроса', response.status)
  }
  return body as T
}
