import { Injectable, Logger } from '@nestjs/common';

export interface WhatsAppMessage {
  to: string;
  body: string;
}

/** Mascara um telefone para log, mantendo só os 4 últimos dígitos (ex.: `***4321`). */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 4 ? '***' : `***${digits.slice(-4)}`;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  async sendWhatsApp(message: WhatsAppMessage): Promise<void> {
    const apiToken = process.env.WHATSAPP_API_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!apiToken || !phoneNumberId) {
      this.logger.warn('WhatsApp credentials not configured — skipping notification');
      return;
    }

    // TODO: implementar chamada à Meta Cloud API
    this.logger.log(`WhatsApp notification sent to ${maskPhone(message.to)}`);
  }
}
