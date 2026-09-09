import nodemailer, { type Transporter } from 'nodemailer'

export interface MagicLinkMailer {
  sendMagicLink(email: string, link: string): Promise<void>
}

export class SmtpMagicLinkMailer implements MagicLinkMailer {
  private readonly transporter: Transporter

  constructor(
    host: string,
    port: number,
    private readonly from: string,
  ) {
    this.transporter = nodemailer.createTransport({ host, port, secure: false })
  }

  async sendMagicLink(email: string, link: string): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: email,
      subject: 'Вход в КАБАНДУ',
      text: `Откройте ссылку, чтобы войти в КАБАНДУ: ${link}\n\nСсылка одноразовая и действует ограниченное время.`,
    })
  }
}
