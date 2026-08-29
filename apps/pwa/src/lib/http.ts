import { diagnosticRequestHeaders } from './diagnostics'

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly errorId: string | null = null,
    readonly apiBuild: string | null = null,
    readonly operationRef: string | null = null,
  ) {
    super(errorId ? `${message} Код: ${errorId.slice(0, 8)}` : message)
  }
}

export async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...diagnosticRequestHeaders(), ...init?.headers },
  })
  const body = response.status === 204 ? null : await response.json()
  if (!response.ok) {
    const error = body?.error
    throw new ApiError(
      error?.code ?? 'REQUEST_FAILED',
      error?.message ?? 'Ошибка запроса',
      response.status,
      error?.errorId ?? response.headers.get('X-Kabanda-Request-Id'),
      response.headers.get('X-Kabanda-Api-Build'),
      error?.operationRef ?? response.headers.get('X-Kabanda-Operation-Ref'),
    )
  }
  return body as T
}
