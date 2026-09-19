import http from 'node:http'
import net from 'node:net'

/** Disposable loopback-only test link. Both absolute-form HTTP (browser) and
 * CONNECT (Playwright APIRequestContext, including HTTP URLs) use the same
 * disconnect switch. No external host, database, credentials or TLS endpoint. */
export async function localLink(ports = [4173, 3000]) {
  const allowedPorts = new Set(ports.map(String))
  if ([...allowedPorts].some(port => !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535)) {
    throw new TypeError('Invalid test listener port')
  }
  const sockets = new Set()
  const remember = socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    return socket
  }
  let link
  const server = http.createServer((request, response) => {
    if (link.offline) { link.denied++; request.socket.destroy(); return }
    let target
    try { target = new URL(request.url ?? '') } catch { response.writeHead(400).end(); return }
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' ||
      !allowedPorts.has(target.port) || target.username || target.password) {
      response.writeHead(403).end(); return
    }
    const headers = { ...request.headers, host: target.host }
    delete headers['proxy-authorization']; delete headers['proxy-connection']
    const upstream = http.request({ hostname: '127.0.0.1', port: target.port, method: request.method,
      path: target.pathname + target.search, headers, agent: false }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers)
      incoming.pipe(response)
    })
    upstream.on('socket', remember)
    upstream.on('error', () => response.destroy())
    request.on('error', () => upstream.destroy())
    response.on('close', () => upstream.destroy())
    request.pipe(upstream)
  })
  server.on('connection', remember)
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('connect', (request, socket, head) => {
    if (link.offline) { link.denied++; socket.destroy(); return }
    // CONNECT authority is parsed strictly: no URL, user-info, IPv6/DNS,
    // alternate loopback spellings, path or arbitrary port may pass this gate.
    const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(request.url ?? '')
    if (!match || !allowedPorts.has(match[1])) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return
    }
    const upstream = remember(net.connect({ host: '127.0.0.1', port: Number(match[1]) }))
    const timeout = setTimeout(() => { upstream.destroy(); socket.destroy() }, 5000)
    const close = () => { clearTimeout(timeout); upstream.destroy(); socket.destroy() }
    socket.on('error', close); socket.on('close', close)
    upstream.on('error', close); upstream.on('close', () => { clearTimeout(timeout); socket.destroy() })
    upstream.once('connect', () => {
      clearTimeout(timeout)
      if (link.offline || socket.destroyed) { close(); return }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local test link did not bind')
  link = { server: `http://127.0.0.1:${address.port}`, offline: false, denied: 0,
    disconnect: () => { for (const socket of sockets) socket.destroy() },
    close: async () => { link.disconnect(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
  return link
}
