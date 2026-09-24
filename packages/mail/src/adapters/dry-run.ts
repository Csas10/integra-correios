import type { MailGateway } from "../domain/gateway.js";
import type { MailDelivery, MailReceipt, OutboundMail } from "../domain/message.js";

/**
 * Gateway SINTÉTICO do DRY_RUN (Fase B).
 *
 * F7 — semanticamente inequívoco: o receipt carrega provider = "DRY_RUN" e
 * messageId prefixado "dryrun-", de modo que NENHUM registro persistido possa
 * ser interpretado como receipt Gmail real e nenhum messageId sintético possa
 * colidir com identidade Gmail real.
 *
 * Nenhuma chamada externa é realizada — o envio real permanece atrás do
 * GmailMailGateway (GATE 1) e da liberação do lote (GATE 2).
 */
export class DryRunMailGateway implements MailGateway {
  readonly enviadas: readonly OutboundMail[] = [];

  async send(message: OutboundMail): Promise<MailReceipt> {
    (this.enviadas as OutboundMail[]).push(message);
    return {
      provider: "DRY_RUN" as const,
      messageId: `dryrun-${message.confirmationId}`,
      acceptedAt: new Date().toISOString(),
    };
  }

  async getStatus(messageId: string): Promise<MailDelivery> {
    return {
      provider: "DRY_RUN" as const,
      messageId,
      status: "ACCEPTED" as const,
      observedAt: new Date().toISOString(),
    };
  }
}
