import type { OutboundMail } from "../domain/message.js";

export const PF_CONFIRMATION_TEMPLATE_VERSION = "pf-confirmation-v1" as const;

export interface ConfirmationMailInput {
  readonly confirmationId: string;
  readonly professionalId: string;
  readonly recipient: string;
  readonly professionalName: string;
  readonly replyTo: string;
  readonly confirmationPath: string;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>\"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}

export function renderPfConfirmationMail(input: ConfirmationMailInput): OutboundMail {
  const safeName = escapeHtml(input.professionalName);
  const safePath = escapeHtml(input.confirmationPath);
  const textBody = [
    `Olá, ${input.professionalName}.`,
    "Precisamos confirmar seus dados cadastrais para uma futura etapa de pré-postagem.",
    "Acesse o formulário seguro para confirmar ou atualizar as informações.",
    input.confirmationPath,
    "Se não reconhecer esta solicitação, responda a este e-mail.",
  ].join("\n\n");
  const htmlBody = `<p>Olá, ${safeName}.</p><p>Precisamos confirmar seus dados cadastrais para uma futura etapa de pré-postagem.</p><p><a href="${safePath}">Confirmar ou atualizar dados</a></p><p>Se não reconhecer esta solicitação, responda a este e-mail.</p>`;

  return {
    idempotencyKey: `pf-confirmation:${input.confirmationId}`,
    confirmationId: input.confirmationId,
    to: input.recipient,
    replyTo: input.replyTo,
    subject: "Confirmação cadastral necessária",
    textBody,
    htmlBody,
    templateVersion: PF_CONFIRMATION_TEMPLATE_VERSION,
  };
}
