import type { OutboundMail } from "../domain/message.js";
import { PILOT_SENDER } from "./pf-pilot.js";

export const PF_UPDATE_CAMPAIGN_TEMPLATE_VERSION =
  "pf-atualizacao-cadastral-2026-v1" as const;

export const PF_UPDATE_CAMPAIGN_SUBJECT =
  "Confirmação dos dados para envio da Carteira Profissional" as const;

export interface PfUpdateCampaignMailInput {
  readonly campaignId: string;
  readonly itemId: string;
  readonly professionalId: string;
  readonly recipient: string;
  readonly professionalName: string;
  readonly correlationCode: string;
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

const CAMPOS_RESPOSTA = [
  "Telefone/WhatsApp com DDD:",
  "CEP:",
  "Logradouro:",
  "Número:",
  "Complemento:",
  "Bairro:",
  "Cidade:",
  "UF:",
] as const;

export function renderPfUpdateCampaignMail(input: PfUpdateCampaignMailInput): OutboundMail {
  const nome = input.professionalName.trim();
  const correlationCode = input.correlationCode.trim();
  if (!nome) throw new Error("Nome de exibição é obrigatório");
  if (!correlationCode || /[\r\n]/.test(correlationCode)) {
    throw new Error("Código de correlação inválido");
  }

  const textBody = [
    `Olá, ${nome}.`,
    "",
    "Para prepararmos o envio da sua Carteira Profissional, responda este",
    "e-mail preenchendo os campos abaixo:",
    "",
    ...CAMPOS_RESPOSTA,
    "",
    `Protocolo: ${correlationCode}`,
    "",
    "Complemento é opcional. Nos demais campos, informe os dados completos;",
    "para Número, use S/N quando aplicável.",
  ].join("\n");

  const camposHtml = CAMPOS_RESPOSTA.map((campo) => escapeHtml(campo)).join("\n");
  const htmlBody = [
    `<p>Olá, <strong>${escapeHtml(nome)}</strong>.</p>`,
    "<p>Para prepararmos o envio da sua Carteira Profissional, responda este e-mail preenchendo os campos abaixo:</p>",
    `<pre>${camposHtml}</pre>`,
    `<p><strong>Protocolo:</strong> ${escapeHtml(correlationCode)}</p>`,
    "<p>Complemento é opcional. Nos demais campos, informe os dados completos; para Número, use S/N quando aplicável.</p>",
  ].join("");

  return {
    idempotencyKey:
      `pf-update:${input.campaignId}:${input.itemId}:${PF_UPDATE_CAMPAIGN_TEMPLATE_VERSION}`,
    confirmationId: input.itemId,
    to: input.recipient,
    replyTo: PILOT_SENDER.address,
    subject: PF_UPDATE_CAMPAIGN_SUBJECT,
    textBody,
    htmlBody,
    templateVersion: PF_UPDATE_CAMPAIGN_TEMPLATE_VERSION,
  };
}
