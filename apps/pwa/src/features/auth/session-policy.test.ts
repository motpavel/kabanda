import { describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/http'
import { sessionFailure, sessionFailureMessage, signInFailureMessage } from './session-policy'

describe('session and sign-in failures', () => {
  it('requests login only for a confirmed unauthenticated response', () => {
    expect(sessionFailure(new ApiError('UNAUTHENTICATED', 'expired', 401))).toBe('anonymous')
    for (const status of [400, 403, 404, 409]) expect(sessionFailure(new ApiError('ERROR', 'error', status))).toBe('unavailable')
  })
  it('does not mistake transport, throttling or server failure for logout', () => {
    for (const error of [new TypeError('offline'), new DOMException('timeout', 'TimeoutError'), new ApiError('BUSY', 'busy', 429), new ApiError('SERVER', 'server', 503)]) {
      expect(sessionFailure(error)).toBe('temporary')
    }
  })
  it('does not accuse credentials when the network has failed', () => {
    expect(signInFailureMessage(new TypeError('offline'))).toContain('связаться с сервером')
    expect(signInFailureMessage(new ApiError('SERVER', 'server', 500))).not.toContain('Неверный')
    expect(signInFailureMessage(new ApiError('INVALID_CREDENTIALS', 'invalid', 401))).toContain('Неверный логин или пароль')
  })
  it('explains rate limiting and revoked access separately', () => {
    expect(signInFailureMessage(new ApiError('LIMITED', 'limited', 429))).toContain('подождите')
    expect(sessionFailureMessage(new ApiError('FORBIDDEN', 'forbidden', 403))).toContain('Доступ')
    expect(sessionFailureMessage(new TypeError('offline'))).not.toContain('пароль')
  })
})
