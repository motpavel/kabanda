function reject(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

let url
let database
let username
let password
try {
  url = new URL(process.env.DATABASE_URL ?? '')
  database = decodeURIComponent(url.pathname.slice(1))
  username = decodeURIComponent(url.username)
  password = decodeURIComponent(url.password)
} catch {
  reject('Invalid stand DATABASE_URL')
}

if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
  reject('DATABASE_URL must use PostgreSQL')
}
if (url.search || url.hash) {
  reject('stand DATABASE_URL must not contain query or fragment overrides')
}
if (url.hostname !== '127.0.0.1') {
  reject('stand database must remain on loopback')
}
if (!url.username || !url.password || !database || database.includes('/')) {
  reject('DATABASE_URL credentials/database are incomplete')
}
const port = url.port || '5432'
if (username !== 'kabanda_preview' || database !== 'kabanda_preview' || port !== '5432') {
  reject('DATABASE_URL does not identify the isolated Kabanda stand database')
}

const values = [
  url.hostname,
  port,
  username,
  password,
  database,
]
process.stdout.write(values.map((value) => `${value}\0`).join(''))
