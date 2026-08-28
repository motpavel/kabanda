import nodemailer, { type Transporter } from 'nodemailer'

export interface MagicLinkMailer {
  sendMagicLink(email: string, link: string): Promise<void>
}

export interface SmtpMailerOptions {
  host: string
  port: number
  secure: boolean
  requireTls: boolean
  user?: string
  password?: string
  from: string
}

export function smtpTransportOptions(options: SmtpMailerOptions) {
  if (Boolean(options.user) !== Boolean(options.password)) {
    throw new Error('SMTP user and password must be configured together')
  }
  if (options.user && !options.secure && !options.requireTls) {
    throw new Error('Authenticated SMTP requires implicit TLS or required STARTTLS')
  }
  return {
    host: options.host,
    port: options.port,
    secure: options.secure,
    requireTLS: options.requireTls,
    ...(options.user && options.password
      ? { auth: { user: options.user, pass: options.password } }
      : {}),
  }
}

export class SmtpMagicLinkMailer implements MagicLinkMailer {
  private readonly transporter: Transporter

  constructor(private readonly options: SmtpMailerOptions) {
    this.transporter = nodemailer.createTransport(smtpTransportOptions(options))
  }

  async sendMagicLink(email: string, link: string): Promise<void> {
    await this.transporter.sendMail({
      from: this.options.from,
      to: email,
      subject: 'Вход в КАБАНДУ',
      text: `Откройте ссылку, чтобы войти в КАБАНДУ: ${link}\n\nСсылка одноразовая и действует ограниченное время.`,
    })
  }
}
