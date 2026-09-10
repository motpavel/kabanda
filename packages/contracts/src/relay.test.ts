import { beforeAll, describe, expect, it } from 'vitest'
import { createRelayKey, decryptRelayBytes, encryptRelayBytes, openRelayRequest, openRelayResponse, relayBytesToBase64, sealRelayRequest, sealRelayResponse } from './relay.js'

let publicKey: string
let privateKey: string
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['wrapKey', 'unwrapKey'])
  publicKey = `-----BEGIN PUBLIC KEY-----\n${relayBytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)))}\n-----END PUBLIC KEY-----`
  privateKey = `-----BEGIN PRIVATE KEY-----\n${relayBytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)))}\n-----END PRIVATE KEY-----`
})
const id = '918b2c3e-f512-4f59-b0f0-18f59fe93e56'

describe('encrypted relay protocol', () => {
  it('keeps login bodies and returned credentials confidential through a request and response', async () => {
    const payload = { operation: 'request' as const, method: 'POST' as const, path: '/api/auth/login', headers: {}, body: { base64: btoa('{"username":"rider","password":"test-password"}') } }
    const outgoing = await sealRelayRequest(publicKey, id, payload)
    expect(JSON.stringify(outgoing.envelope)).not.toContain('test-password')
    expect(JSON.stringify(outgoing.envelope)).not.toContain('/api/auth/login')
    const received = await openRelayRequest(privateKey, outgoing.envelope)
    expect(received.payload).toEqual(payload)
    const reply = { operation: 'response' as const, status: 200, headers: {}, bodyBase64: btoa('{"ok":true}'), session: 'opaque-credential' }
    const encrypted = await sealRelayResponse(received.key, id, reply)
    expect(JSON.stringify(encrypted)).not.toContain('opaque-credential')
    expect(await openRelayResponse(outgoing.key, id, encrypted)).toEqual(reply)
  })

  it('rejects substitution between request ids, directions, and separate request keys', async () => {
    const key = await createRelayKey()
    const bytes = await encryptRelayBytes(key, id, 'body', new Uint8Array([1, 2, 3]))
    await expect(decryptRelayBytes(key, crypto.randomUUID(), 'body', bytes)).rejects.toThrow()
    await expect(decryptRelayBytes(key, id, 'response', bytes)).rejects.toThrow()
    await expect(decryptRelayBytes(await createRelayKey(), id, 'body', bytes)).rejects.toThrow()
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
    await expect(decryptRelayBytes(key, id, 'body', bytes)).rejects.toThrow()
  })

  it('transfers a binary image with an independently randomized nonce on each encryption', async () => {
    const key = await createRelayKey()
    const image = new Uint8Array(1024 * 1024).fill(137)
    const first = await encryptRelayBytes(key, id, 'body', image)
    const second = await encryptRelayBytes(key, id, 'body', image)
    expect(first).not.toEqual(second)
    expect(await decryptRelayBytes(key, id, 'body', first)).toEqual(image)
  })
})
