// Run through `docker compose exec -T api node --input-type=module` after startup.
// Read-only probe: readiness + encrypted /api/health; no account or route writes.
import { createHash, createPublicKey, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const origin = new URL(process.env.APP_ORIGIN)
const apiPort = process.env.API_PORT ?? '3098'
const relayPort = process.env.RELAY_PORT ?? '3099'
for (const port of [apiPort, relayPort]) {
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid probe port')
}
const ready = await fetch(`http://127.0.0.1:${apiPort}/api/ready`, {
  headers: { 'x-forwarded-host': origin.host, 'x-forwarded-proto': 'https' },
  signal: AbortSignal.timeout(5000),
})
if (!ready.ok || (await ready.json()).status !== 'ready') throw new Error('API database readiness failed')

const privatePem = await readFile(process.env.RELAY_PRIVATE_KEY_FILE, 'utf8')
const publicDer = createPublicKey(privatePem).export({ type: 'spki', format: 'der' })
const publicKey = await crypto.subtle.importKey('spki', publicDer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['wrapKey'])
const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
const id = randomUUID()
const aad = (purpose) => new TextEncoder().encode(`kabanda:relay:v1:${id}:${purpose}`)
const iv = crypto.getRandomValues(new Uint8Array(12))
const bytes = new TextEncoder().encode(JSON.stringify({ operation: 'request', method: 'GET', path: '/api/health', headers: {} }))
const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad('request'), tagLength: 128 }, key, bytes)
const wrappedKey = await crypto.subtle.wrapKey('raw', key, publicKey, { name: 'RSA-OAEP', label: aad('request') })
const envelope = {
  version: 1, id,
  iv: Buffer.from(iv).toString('base64'),
  ciphertext: Buffer.from(ciphertext).toString('base64'),
  wrappedKey: Buffer.from(wrappedKey).toString('base64'),
}
const outer = await fetch(`http://127.0.0.1:${relayPort}/relay/v1/request`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(envelope), signal: AbortSignal.timeout(20_000),
})
if (!outer.ok) throw new Error('Encrypted relay request failed')
const response = await outer.json()
if (response.version !== 1 || typeof response.iv !== 'string' || typeof response.ciphertext !== 'string') throw new Error('Invalid encrypted health response')
const clear = await crypto.subtle.decrypt({
  name: 'AES-GCM', iv: Buffer.from(response.iv, 'base64'), additionalData: aad('response'), tagLength: 128,
}, key, Buffer.from(response.ciphertext, 'base64'))
const result = JSON.parse(new TextDecoder().decode(clear))
if (result.operation !== 'response' || result.status !== 200) throw new Error('Inner API health failed')
const health = JSON.parse(Buffer.from(result.bodyBase64, 'base64').toString('utf8'))
if (health.status !== 'ok' || health.service !== 'kabanda-api') throw new Error('Unexpected health service')
console.log(JSON.stringify({
  apiReady: true, encryptedRelayRoundTrip: true,
  publicKeySpkiSha256: createHash('sha256').update(publicDer).digest('hex'),
  apiBuild: process.env.API_BUILD_ID,
}))
