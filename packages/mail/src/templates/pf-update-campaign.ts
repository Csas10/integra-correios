import type { OutboundMail } from "../domain/message.js";

/**
 * SLICE-03C.2A — identidade de remetente INJETADA server-side: o template da
 * campanha NÃO depende mais do piloto (PILOT_SENDER). O endereço institucional
 * homologado (carteiras@crtba.org.br) é fornecido pela fronteira runtime
 * (derivação server-side); o browser não escolhe From, Reply-To nem Message-ID.
 */
export interface RemetenteCampanha {
  readonly name: string;
  readonly address: string;
}

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
  /** Identidade server-side (obrigatória no caminho da campanha). */
  readonly remetente: RemetenteCampanha;
  /** Tag do Message-ID (ex.: "pf-campanha"); domínio vem do remetente. */
  readonly messageTag?: string;
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
  const remetente = input.remetente;
  const messageTag = (input.messageTag ?? "pf-campanha").trim() || "pf-campanha";
  if (!nome) throw new Error("Nome de exibição é obrigatório");
  if (!correlationCode || /[\r\n]/.test(correlationCode)) {
    throw new Error("Código de correlação inválido");
  }
  if (
    !remetente ||
    !remetente.name.trim() ||
    !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(remetente.address.trim().toLowerCase()) ||
    /[\r\n]/.test(remetente.name) ||
    /[\r\n]/.test(remetente.address)
  ) {
    throw new Error("Remetente da campanha inválido");
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
    from: { name: remetente.name.trim(), address: remetente.address.trim().toLowerCase() },
    messageTag,
    replyTo: remetente.address.trim().toLowerCase(),
    subject: PF_UPDATE_CAMPAIGN_SUBJECT,
    textBody,
    htmlBody,
    templateVersion: PF_UPDATE_CAMPAIGN_TEMPLATE_VERSION,
  };
}
