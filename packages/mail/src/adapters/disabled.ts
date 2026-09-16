import {
  MailProviderNaoConfiguradoError,
  type MailGateway,
} from "../domain/gateway.js";
import type { MailDelivery, MailProvider, MailReceipt, OutboundMail } from "../domain/message.js";

/**
 * Adapter explícito para manter a fundação sem rede ou credenciais.
 * Implementações Gmail, Microsoft Graph e Resend entram em fases posteriores.
 */
export class DisabledMailGateway implements MailGateway {
  constructor(readonly provider: MailProvider) {}

  async send(_message: OutboundMail): Promise<MailReceipt> {
    throw new MailProviderNaoConfiguradoError(this.provider);
  }

  async getStatus(_messageId: string): Promise<MailDelivery> {
    throw new MailProviderNaoConfiguradoError(this.provider);
  }
}
