import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/http'
import { uploadMediaContent } from './api'

describe('uploadMediaContent support correlation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('preserves privacy-safe error, build and operation identifiers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 'MEDIA_REJECTED',
        message: 'Фото отклонено',
        errorId: '70a59f6b-8c7f-4ca4-a8d5-b03ce1a1d3e5',
        operationRef: '0123456789abcdef',
      },
    }), {
      status: 422,
      headers: {
        'content-type': 'application/json',
        'X-Kabanda-Api-Build': 'api-test-build',
      },
    })))

    const failure = await uploadMediaContent(
      '2fc18de7-16c3-42d8-93b5-81647462c573',
      '9d1820c6-1565-4dc0-aa0e-59348db9f0ba',
      'opaque-capability',
      '0'.repeat(64),
      new Blob(['synthetic'], { type: 'image/png' }),
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({
      code: 'MEDIA_REJECTED',
      status: 422,
      errorId: '70a59f6b-8c7f-4ca4-a8d5-b03ce1a1d3e5',
      apiBuild: 'api-test-build',
      operationRef: '0123456789abcdef',
    })
  })
})
