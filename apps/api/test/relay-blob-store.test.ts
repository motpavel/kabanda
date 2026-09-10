import { Readable } from 'node:stream'
import { S3Client } from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'
import { S3RelayBlobStore } from '../src/relay-blob-store.js'

const id = 'fea9d35f-3bd5-4da7-99fb-9d84d7a85e37'
const owner = 'user-test'
function fixture() {
  let now = 100_000
  const client = new S3Client({
    endpoint: 'https://storage.yandexcloud.net', region: 'ru-central1', forcePathStyle: true,
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  })
  const send = vi.spyOn(client, 'send')
  const store = new S3RelayBlobStore({ bucket: 'kabanda-private-test', accessKeyId: 'test-key', secretAccessKey: 'test-secret', ticketSecret: 'test-private-ticket-secret-at-least-32-characters', now: () => now, client })
  return { store, send, advance: (milliseconds: number) => { now += milliseconds } }
}

describe('private relay blobs', () => {
  it('grants only a bounded PUT at our exact private bucket and binds the upload to its owner and request', async () => {
    const { store, send } = fixture()
    const upload = await store.prepareUpload({ id, byteLength: 64, owner })
    const url = new URL(upload.url)
    expect(url.origin).toBe('https://storage.yandexcloud.net')
    expect(url.pathname).toMatch(new RegExp(`^/kabanda-private-test/transport/v1/blobs/kabanda/uploads/${id}/`))
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600')
    await expect(store.readUpload({ ticket: upload.ticket, id, owner: 'someone-else' })).rejects.toThrow('Invalid relay upload ticket')
    await expect(store.readUpload({ ticket: upload.ticket, id: crypto.randomUUID(), owner })).rejects.toThrow('Invalid relay upload ticket')
    await expect(store.readUpload({ ticket: `${upload.ticket}tampered`, id, owner })).rejects.toThrow('Invalid relay upload ticket')
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects expired tickets before accessing storage', async () => {
    const { store, send, advance } = fixture()
    const upload = await store.prepareUpload({ id, byteLength: 64, owner })
    advance(600_000)
    await expect(store.readUpload({ ticket: upload.ticket, id, owner })).rejects.toThrow('Invalid relay upload ticket')
    expect(send).not.toHaveBeenCalled()
  })

  it('reads encrypted bytes identically on a retry and enforces actual length', async () => {
    const { store, send } = fixture()
    const upload = await store.prepareUpload({ id, byteLength: 64, owner })
    send.mockImplementation(async () => ({ ContentLength: 64, Body: Readable.from([Buffer.alloc(64, 9)]) }))
    expect(await store.readUpload({ ticket: upload.ticket, id, owner })).toEqual(Buffer.alloc(64, 9))
    expect(await store.readUpload({ ticket: upload.ticket, id, owner })).toEqual(Buffer.alloc(64, 9))
    send.mockImplementation(async () => ({ ContentLength: 64, Body: Readable.from([Buffer.alloc(65)]) }))
    await expect(store.readUpload({ ticket: upload.ticket, id, owner })).rejects.toThrow('length mismatch')
  })

  it('never sets public ACL on an encrypted response and uses an expiring GET', async () => {
    const { store, send } = fixture()
    send.mockImplementation(async () => ({}))
    const body = new TextEncoder().encode('{"ciphertext":"encrypted"}')
    const url = new URL(await store.publishResponse({ id, body }))
    const command = send.mock.calls[0]![0]
    expect(command.input).toMatchObject({ Bucket: 'kabanda-private-test', CacheControl: 'private, no-store', Body: body })
    expect(command.input).not.toHaveProperty('ACL')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
  })

  it('rejects excessive or malformed upload sizes without issuing capabilities', async () => {
    const { store } = fixture()
    for (const byteLength of [0, 27, 8 * 1024 * 1024 + 29, Number.NaN, 64.5]) {
      await expect(store.prepareUpload({ id, byteLength, owner })).rejects.toThrow('Invalid relay upload')
    }
    await expect(store.prepareUpload({ id: '../../other-prefix', byteLength: 64, owner })).rejects.toThrow('Invalid relay request id')
  })
})
