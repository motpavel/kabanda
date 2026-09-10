import { z } from 'zod'

export const RELAY_INLINE_BODY_BYTES = 32 * 1024
export const RELAY_MAX_BODY_BYTES = 8 * 1024 * 1024
export const RELAY_MAX_RESPONSE_BYTES = 24 * 1024 * 1024
export const RELAY_INLINE_RESPONSE_BYTES = 96 * 1024
const encoded = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).refine((value) => value.length % 4 === 0)
const idSchema = z.uuid()
const sessionSchema = z.string().min(1).max(16_384).optional()
export const relayRequestPayloadSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('request'),
    session: sessionSchema,
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().min(5).max(8_192),
    headers: z.record(z.string().max(128), z.string().max(8_192)),
    body: z.union([
      z.object({ base64: encoded.max(4 * Math.ceil(RELAY_INLINE_BODY_BYTES / 3)) }).strict(),
      z.object({ uploadTicket: z.string().min(1).max(8_192) }).strict(),
    ]).optional(),
  }).strict(),
  z.object({
    operation: z.literal('upload'),
    session: sessionSchema,
    targetId: idSchema,
    byteLength: z.number().int().min(28).max(RELAY_MAX_BODY_BYTES + 28),
  }).strict(),
])
export type RelayRequestPayload = z.infer<typeof relayRequestPayloadSchema>

export const relayResponsePayloadSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('response'),
    status: z.number().int().min(200).max(599),
    headers: z.record(z.string().max(128), z.string().max(8_192)),
    bodyBase64: encoded.max(4 * Math.ceil(RELAY_MAX_RESPONSE_BYTES / 3)),
    session: sessionSchema.unwrap().nullable().optional(),
  }).strict(),
  z.object({ operation: z.literal('upload'), url: z.url(), ticket: z.string().max(8_192) }).strict(),
])
export type RelayResponsePayload = z.infer<typeof relayResponsePayloadSchema>

export const relayCipherSchema = z.object({
  version: z.literal(1),
  iv: encoded.length(16),
  ciphertext: encoded.max(48 * 1024 * 1024),
}).strict()
export type RelayCipher = z.infer<typeof relayCipherSchema>
export const relayEnvelopeSchema = relayCipherSchema.extend({
  id: idSchema,
  wrappedKey: encoded.min(344).max(1_368),
  ciphertext: encoded.max(192 * 1024),
}).strict()
export type RelayEnvelope = z.infer<typeof relayEnvelopeSchema>
export type RelayWireResponse = RelayCipher | { version: 1; objectUrl: string }

export function relayBytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export function relayBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  encoded.parse(value)
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function aad(id: string, purpose: 'request' | 'response' | 'body'): Uint8Array<ArrayBuffer> {
  idSchema.parse(id)
  return encoder.encode(`kabanda:relay:v1:${id}:${purpose}`)
}

function pemBytes(pem: string, kind: 'PUBLIC' | 'PRIVATE'): Uint8Array<ArrayBuffer> {
  const match = pem.trim().match(new RegExp(`^-----BEGIN ${kind} KEY-----\\s+([A-Za-z0-9+/=\\s]+)\\s+-----END ${kind} KEY-----$`))
  if (!match?.[1]) throw new Error('Invalid relay key format')
  return relayBase64ToBytes(match[1].replace(/\s/g, ''))
}

export async function createRelayKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

export async function encryptRelayBytes(
  key: CryptoKey,
  id: string,
  purpose: 'request' | 'response' | 'body',
  bytes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(id, purpose), tagLength: 128 },
    key,
    new Uint8Array(bytes),
  )
  const result = new Uint8Array(iv.byteLength + encrypted.byteLength)
  result.set(iv)
  result.set(new Uint8Array(encrypted), iv.byteLength)
  return result
}

export async function decryptRelayBytes(
  key: CryptoKey,
  id: string,
  purpose: 'request' | 'response' | 'body',
  bytes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (bytes.byteLength < 28 || bytes.byteLength > 48 * 1024 * 1024) throw new Error('Invalid relay ciphertext length')
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(bytes.subarray(0, 12)), additionalData: aad(id, purpose), tagLength: 128 },
    key,
    new Uint8Array(bytes.subarray(12)),
  ))
}

function toCipher(bytes: Uint8Array): RelayCipher {
  return { version: 1, iv: relayBytesToBase64(bytes.subarray(0, 12)), ciphertext: relayBytesToBase64(bytes.subarray(12)) }
}

function fromCipher(input: RelayCipher): Uint8Array<ArrayBuffer> {
  const cipher = relayCipherSchema.parse(input)
  const iv = relayBase64ToBytes(cipher.iv)
  const ciphertext = relayBase64ToBytes(cipher.ciphertext)
  const bytes = new Uint8Array(iv.length + ciphertext.length)
  bytes.set(iv)
  bytes.set(ciphertext, iv.length)
  return bytes
}

export async function sealRelayRequest(
  publicKeyPem: string,
  id: string,
  payload: RelayRequestPayload,
  suppliedKey?: CryptoKey,
): Promise<{ key: CryptoKey; envelope: RelayEnvelope }> {
  const key = suppliedKey ?? await createRelayKey()
  const validated = relayRequestPayloadSchema.parse(payload)
  const publicKey = await crypto.subtle.importKey('spki', pemBytes(publicKeyPem, 'PUBLIC'), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['wrapKey'])
  const wrappedKey = await crypto.subtle.wrapKey('raw', key, publicKey, { name: 'RSA-OAEP', label: aad(id, 'request') })
  const cipher = toCipher(await encryptRelayBytes(key, id, 'request', encoder.encode(JSON.stringify(validated))))
  return { key, envelope: relayEnvelopeSchema.parse({ ...cipher, id, wrappedKey: relayBytesToBase64(new Uint8Array(wrappedKey)) }) }
}

export async function openRelayRequest(
  privateKeyPkcs8Pem: string,
  input: RelayEnvelope,
): Promise<{ key: CryptoKey; payload: RelayRequestPayload }> {
  const envelope = relayEnvelopeSchema.parse(input)
  const privateKey = await crypto.subtle.importKey('pkcs8', pemBytes(privateKeyPkcs8Pem, 'PRIVATE'), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['unwrapKey'])
  const key = await crypto.subtle.unwrapKey('raw', relayBase64ToBytes(envelope.wrappedKey), privateKey,
    { name: 'RSA-OAEP', label: aad(envelope.id, 'request') }, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const bytes = await decryptRelayBytes(key, envelope.id, 'request', fromCipher({ version: 1, iv: envelope.iv, ciphertext: envelope.ciphertext }))
  return { key, payload: relayRequestPayloadSchema.parse(JSON.parse(decoder.decode(bytes))) }
}

export async function sealRelayResponse(key: CryptoKey, id: string, payload: RelayResponsePayload): Promise<RelayCipher> {
  const validated = relayResponsePayloadSchema.parse(payload)
  return toCipher(await encryptRelayBytes(key, id, 'response', encoder.encode(JSON.stringify(validated))))
}

export async function openRelayResponse(key: CryptoKey, id: string, cipher: RelayCipher): Promise<RelayResponsePayload> {
  const bytes = await decryptRelayBytes(key, id, 'response', fromCipher(cipher))
  return relayResponsePayloadSchema.parse(JSON.parse(decoder.decode(bytes)))
}
