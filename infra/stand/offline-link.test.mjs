import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { test } from 'node:test'
import { localLink } from '../../e2e/offline-link.mjs'

async function fixture(run) {
  let hits = 0
  const origin = http.createServer((request, response) => {
    hits++
    const body = []
    request.on('data', chunk => body.push(chunk))
    request.on('end', () => response.end(`accepted:${Buffer.concat(body)}`))
  })
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening')
  const port = origin.address().port
  const link = await localLink([port])
  try { await run({ link, port, hits: () => hits }) }
  finally { await link.close(); origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)) }
}
function exchange(link, message) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(new URL(link.server).port) })
    const chunks = []
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Test link stalled')) })
    socket.on('connect', () => socket.end(message))
    socket.on('data', chunk => chunks.push(chunk))
    socket.on('error', reject)
    socket.on('close', () => resolve(Buffer.concat(chunks).toString()))
  })
}
function tunnelRequest(link, port, body) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(new URL(link.server).port) })
    let response = '', connected = false
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Tunnel stalled')) })
    socket.on('connect', () => socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`))
    socket.on('data', chunk => {
      response += chunk
      if (!connected && response.includes('\r\n\r\n')) {
        if (!response.startsWith('HTTP/1.1 200 Connection Established')) { socket.destroy(); reject(new Error(response)); return }
        connected = true; response = ''
        socket.write(`POST /api/test HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
      }
    })
    socket.on('error', reject)
    socket.on('close', () => resolve(response))
  })
}

test('loopback forwarder supports actual HTTP and CONNECT without altering payloads', { timeout: 10_000 }, async () => {
  await fixture(async ({ link, port, hits }) => {
    const direct = await new Promise((resolve, reject) => {
      const request = http.request(link.server, { path: `http://127.0.0.1:${port}/api/test`, method: 'POST' }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve(Buffer.concat(chunks).toString()))
      })
      request.on('error', reject); request.end('http-payload')
    })
    assert.equal(direct, 'accepted:http-payload')
    assert.match(await tunnelRequest(link, port, 'tunnel-payload'), /accepted:tunnel-payload$/)
    assert.equal(hits(), 2)
  })
})

test('offline link denies HTTP and CONNECT, then restores real transport', { timeout: 10_000 }, async () => {
  await fixture(async ({ link, port, hits }) => {
    link.offline = true; link.disconnect()
    assert.equal(await exchange(link, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`), '')
    assert.equal(await exchange(link, `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`), '')
    assert.equal(hits(), 0); assert.equal(link.denied, 2)
    link.offline = false
    assert.match(await tunnelRequest(link, port, 'restored'), /accepted:restored$/)
    assert.equal(hits(), 1)
  })
})

test('CONNECT rejects external hosts, credentials, paths, and unapproved local ports', { timeout: 10_000 }, async () => {
  await fixture(async ({ link, port, hits }) => {
    for (const authority of [`example.invalid:${port}`, `localhost:${port}`, `127.0.0.1:${port}/path`,
      `user:secret@127.0.0.1:${port}`, '127.0.0.1:5432', `[::1]:${port}`, `http://127.0.0.1:${port}`]) {
      assert.match(await exchange(link, `CONNECT ${authority} HTTP/1.1\r\nHost: ignored\r\n\r\n`), /403 Forbidden/, authority)
    }
    assert.equal(hits(), 0)
  })
})

test('disconnect tears down an already-established tunnel', { timeout: 10_000 }, async () => {
  await fixture(async ({ link, port, hits }) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(new URL(link.server).port) })
    socket.on('error', () => {})
    await once(socket, 'connect')
    socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
    const [header] = await once(socket, 'data')
    assert.match(header.toString(), /200 Connection Established/)
    const closed = once(socket, 'close')
    link.offline = true; link.disconnect()
    await closed
    assert.equal(hits(), 0)
  })
})
