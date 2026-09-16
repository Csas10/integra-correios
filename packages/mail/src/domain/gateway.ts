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

export class DestinatarioNaoAutorizadoError extends Error {
  constructor() {
    super("Destinatário fora da whitelist de homologação");
    this.name = "DestinatarioNaoAutorizadoError";
  }
}

export class MailProviderRequestError extends Error {
  constructor(provider: string, operation: string) {
    super(`Falha do provedor ${provider} durante ${operation}`);
    this.name = "MailProviderRequestError";
  }
}
