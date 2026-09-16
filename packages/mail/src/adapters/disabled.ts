import {
  MailProviderNaoConfiguradoError,
  type MailGateway,
} from "../domain/gateway.js";
import type { MailDelivery, MailProvider, MailReceipt, OutboundMail } from "../domain/message.js";

/**
 * Adapter explícito para manter o envio bloqueado sem configuração autorizada.
 * Gmail e Microsoft Graph continuam reservados; Resend possui somente o spike
 * de homologação protegido por modo e whitelist.
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
