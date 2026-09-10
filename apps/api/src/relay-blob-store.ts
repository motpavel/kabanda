import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { RELAY_MAX_BODY_BYTES } from '@kabanda/contracts/relay'

const prefix = 'transport/v1/blobs/kabanda/'
const ticketLifetimeMs = 10 * 60_000
const maxCipherBytes = RELAY_MAX_BODY_BYTES + 28

export interface RelayBlobStore {
  prepareUpload(input: { id: string; byteLength: number; owner: string }): Promise<{ url: string; ticket: string }>
  readUpload(input: { ticket: string; id: string; owner: string }): Promise<Uint8Array>
  publishResponse(input: { id: string; body: Uint8Array }): Promise<string>
}

interface UploadTicket {
  version: 1
  id: string
  key: string
  owner: string
  byteLength: number
  expiresAt: number
}

export class S3RelayBlobStore implements RelayBlobStore {
  private readonly client: S3Client
  private readonly bucket: string
  private readonly secret: string
  private readonly now: () => number

  constructor(options: { bucket: string; accessKeyId: string; secretAccessKey: string; ticketSecret: string; now?: () => number; client?: S3Client }) {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket)) throw new Error('Invalid private relay bucket')
    if (options.ticketSecret.length < 32) throw new Error('Relay ticket secret must contain at least 32 characters')
    this.bucket = options.bucket
    this.secret = options.ticketSecret
    this.now = options.now ?? Date.now
    this.client = options.client ?? new S3Client({
      endpoint: 'https://storage.yandexcloud.net',
      region: 'ru-central1',
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 2,
    })
  }

  private signature(value: string): string {
    return createHmac('sha256', this.secret).update(`kabanda-relay-upload-v1:${value}`).digest('base64url')
  }

  private ownerHash(owner: string): string {
    return createHmac('sha256', this.secret).update(`kabanda-relay-owner-v1:${owner}`).digest('base64url')
  }

  private assertId(id: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid relay request id')
  }

  async prepareUpload(input: { id: string; byteLength: number; owner: string }): Promise<{ url: string; ticket: string }> {
    this.assertId(input.id)
    if (!input.owner || !Number.isSafeInteger(input.byteLength) || input.byteLength < 28 || input.byteLength > maxCipherBytes) throw new Error('Invalid relay upload')
    const payload: UploadTicket = {
      version: 1,
      id: input.id,
      key: `${prefix}uploads/${input.id}/${randomUUID()}`,
      owner: this.ownerHash(input.owner),
      byteLength: input.byteLength,
      expiresAt: this.now() + ticketLifetimeMs,
    }
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const ticket = `${encoded}.${this.signature(encoded)}`
    const url = await getSignedUrl(this.client, new PutObjectCommand({
      Bucket: this.bucket,
      Key: payload.key,
      ContentType: 'application/octet-stream',
      ContentLength: input.byteLength,
    }), { expiresIn: ticketLifetimeMs / 1000 })
    return { url, ticket }
  }

  private verifyTicket(input: { ticket: string; id: string; owner: string }): UploadTicket {
    this.assertId(input.id)
    if (input.ticket.length > 8_192) throw new Error('Invalid relay upload ticket')
    const parts = input.ticket.split('.')
    if (parts.length !== 2) throw new Error('Invalid relay upload ticket')
    const [encoded, signature] = parts as [string, string]
    const expected = Buffer.from(this.signature(encoded))
    const actual = Buffer.from(signature)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid relay upload ticket')
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as UploadTicket
    if (payload.version !== 1 || payload.id !== input.id || payload.owner !== this.ownerHash(input.owner)
      || !Number.isSafeInteger(payload.byteLength) || payload.byteLength < 28 || payload.byteLength > maxCipherBytes
      || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= this.now()
      || payload.expiresAt > this.now() + ticketLifetimeMs
      || !payload.key.startsWith(`${prefix}uploads/${input.id}/`)
      || !/^[a-zA-Z0-9/-]+$/.test(payload.key)) throw new Error('Invalid relay upload ticket')
    return payload
  }

  async readUpload(input: { ticket: string; id: string; owner: string }): Promise<Uint8Array> {
    const payload = this.verifyTicket(input)
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: payload.key }), { abortSignal: AbortSignal.timeout(15_000) })
    if (!result.Body || result.ContentLength !== payload.byteLength) throw new Error('Relay upload length mismatch')
    const chunks: Uint8Array[] = []
    let length = 0
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
      length += chunk.length
      if (length > payload.byteLength) throw new Error('Relay upload length mismatch')
      chunks.push(chunk)
    }
    if (length !== payload.byteLength) throw new Error('Relay upload length mismatch')
    // Objects remain private until lifecycle cleanup; a retry can safely read the same bytes.
    return Buffer.concat(chunks, length)
  }

  async publishResponse(input: { id: string; body: Uint8Array }): Promise<string> {
    this.assertId(input.id)
    if (input.body.byteLength > 48 * 1024 * 1024) throw new Error('Relay response exceeds limit')
    const key = `${prefix}responses/${input.id}/${randomUUID()}`
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: input.body,
      ContentType: 'application/json',
      CacheControl: 'private, no-store',
    }), { abortSignal: AbortSignal.timeout(15_000) })
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: 5 * 60 })
  }
}
