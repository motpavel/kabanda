import { describe, expect, it } from 'vitest'
import { smtpTransportOptions } from '../src/mailer.js'

describe('SMTP transport options', () => {
  it('supports loopback Mailpit and authenticated TLS SMTP without leaking the from address', () => {
    expect(
      smtpTransportOptions({
        host: '127.0.0.1',
        port: 1025,
        secure: false,
        requireTls: false,
        from: 'kabanda@example.test',
      }),
    ).toEqual({ host: '127.0.0.1', port: 1025, secure: false, requireTLS: false })

    expect(
      smtpTransportOptions({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        requireTls: true,
        user: 'kabanda',
        password: 'secret',
        from: 'hello@example.com',
      }),
    ).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'kabanda', pass: 'secret' },
    })
  })

  it('rejects authenticated SMTP without implicit TLS or required STARTTLS', () => {
    expect(() =>
      smtpTransportOptions({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        requireTls: false,
        user: 'kabanda',
        password: 'secret',
        from: 'hello@example.com',
      }),
    ).toThrow('Authenticated SMTP requires implicit TLS or required STARTTLS')
  })
})
