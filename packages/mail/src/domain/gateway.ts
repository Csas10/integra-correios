import type { MailDelivery, MailReceipt, OutboundMail } from "./message.js";

export interface MailGateway {
  send(message: OutboundMail): Promise<MailReceipt>;
  getStatus(messageId: string): Promise<MailDelivery>;
}

export class MailProviderNaoConfiguradoError extends Error {
  constructor(provider: string) {
    super(`Provedor de e-mail não configurado: ${provider}`);
    this.name = "MailProviderNaoConfiguradoError";
  }
}
