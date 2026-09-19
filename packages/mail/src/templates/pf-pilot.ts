import type { OutboundMail } from "../domain/message.js";

/**
 * Template institucional versionado do piloto PF.
 *
 * - Remetente: CRT-BA | Carteiras Profissionais <carteiras@crtba.org.br>
 * - Assunto fixo institucional;
 * - Conteúdo: nome, endereço, telefone e WhatsApp quando aplicável;
 * - NUNCA inclui CPF no corpo;
 * - Ações: CONFIRMAR DADOS / ATUALIZAR DADOS (links por token de alta
 *   entropia — nunca PII na URL).
 *
 * A versão do template é persistida em comunicacao.template_versao pelo
 * repository no momento da criação transacional do lote.
 */
export const PF_PILOT_TEMPLATE_VERSION = "pf-pilot-crtba-v1" as const;

export const PILOT_SENDER = Object.freeze({
  name: "CRT-BA | Carteiras Profissionais",
  address: "carteiras@crtba.org.br",
});

export const PILOT_SUBJECT =
  "Confirmação de dados para envio da Carteira Profissional";

export interface PilotConfirmationMailInput {
  readonly confirmationId: string;
  readonly recipient: string;
  readonly professionalName: string;
  readonly enderecoApresentado: string;
  readonly telefone: string;
  readonly whatsapp?: string;
  readonly confirmUrl: string;
  readonly updateUrl: string;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}

/**
 * Renderiza a comunicação institucional do piloto.
 * Endereço/telefone são APENAS os dados apresentados ao profissional para
 * revisão — origem preservada no snapshot; nada aqui substitui dados.
 */
export function renderPfPilotConfirmationMail(
  input: PilotConfirmationMailInput,
): OutboundMail {
  const safeName = escapeHtml(input.professionalName);
  const safeEndereco = escapeHtml(input.enderecoApresentado);
  const safeTelefone = escapeHtml(input.telefone);
  const whatsappLinha = input.whatsapp
    ? `<p><strong>WhatsApp:</strong> ${escapeHtml(input.whatsapp)}</p>`
    : "";
  const whatsappTexto = input.whatsapp ? `\nWhatsApp: ${input.whatsapp}` : "";
  const safeConfirmUrl = escapeHtml(input.confirmUrl);
  const safeUpdateUrl = escapeHtml(input.updateUrl);

  const textBody = [
    `Olá, ${input.professionalName}.`,
    "A CRT-BA precisa confirmar seus dados cadastrais antes do envio da sua Carteira Profissional pelos Correios.",
    "",
    "Dados que temos registrados:",
    `Endereço: ${input.enderecoApresentado}`,
    `Telefone: ${input.telefone}${whatsappTexto}`,
    "",
    "Se os dados estão corretos, confirme:",
    input.confirmUrl,
    "",
    "Se precisa corrigir algo, informe os dados atualizados:",
    input.updateUrl,
    "",
    "Se não reconhece esta solicitação, ignore este e-mail.",
  ].join("\n");

  const htmlBody = [
    `<p>Olá, <strong>${safeName}</strong>.</p>`,
    "<p>A CRT-BA precisa confirmar seus dados cadastrais antes do envio da sua Carteira Profissional pelos Correios.</p>",
    "<h3>Dados que temos registrados</h3>",
    `<p><strong>Endereço:</strong> ${safeEndereco}</p>`,
    `<p><strong>Telefone:</strong> ${safeTelefone}</p>`,
    whatsappLinha,
    `<p><a href="${safeConfirmUrl}">CONFIRMAR DADOS</a> &nbsp;·&nbsp; <a href="${safeUpdateUrl}">ATUALIZAR DADOS</a></p>`,
    "<p>Se não reconhece esta solicitação, ignore este e-mail.</p>",
  ].join("");

  return {
    idempotencyKey: `pf-pilot:${input.confirmationId}:${PF_PILOT_TEMPLATE_VERSION}`,
    confirmationId: input.confirmationId,
    to: input.recipient,
    replyTo: PILOT_SENDER.address,
    subject: PILOT_SUBJECT,
    textBody,
    htmlBody,
    templateVersion: PF_PILOT_TEMPLATE_VERSION,
  };
}
