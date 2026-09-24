import { describe, expect, it } from "vitest";
import {
  composeMimeMessage,
  PF_UPDATE_CAMPAIGN_SUBJECT,
  PF_UPDATE_CAMPAIGN_TEMPLATE_VERSION,
  renderPfUpdateCampaignMail,
} from "../src/index.js";

function decodeSubject(mime: string): string {
  const header = mime.split("\r\n").find((line) => line.startsWith("Subject: "));
  if (!header) throw new Error("Subject ausente");
  const value = header.slice("Subject: ".length);
  const match = /^=\?UTF-8\?B\?([^?]+)\?=$/.exec(value);
  if (!match?.[1]) throw new Error("Subject não está em RFC 2047 Base64 UTF-8");
  return Buffer.from(match[1], "base64").toString("utf8");
}

describe("Campanha PF — template de atualização cadastral", () => {
  const message = renderPfUpdateCampaignMail({
    campaignId: "camp-001",
    itemId: "item-001",
    professionalId: "registro-1001",
    recipient: "profissional@example.com",
    professionalName: "Ana Silva",
    correlationCode: "PF26-A1B2C3",
  });

  it("usa assunto institucional exato e versão própria", () => {
    expect(message.subject).toBe("Confirmação dos dados para envio da Carteira Profissional");
    expect(message.templateVersion).toBe(PF_UPDATE_CAMPAIGN_TEMPLATE_VERSION);
    expect(message.idempotencyKey).toContain("camp-001:item-001");
  });

  it("inclui bloco estruturado para resposta sem depender da página de confirmação", () => {
    for (const field of [
      "Telefone/WhatsApp com DDD:",
      "CEP:",
      "Logradouro:",
      "Número:",
      "Complemento:",
      "Bairro:",
      "Cidade:",
      "UF:",
      "Protocolo: PF26-A1B2C3",
    ]) {
      expect(message.textBody).toContain(field);
    }
    expect(message.textBody).not.toContain("/confirma/");
    expect(message.htmlBody).not.toContain("<script");
  });

  it("MIME codifica Subject em RFC 2047 e decodifica exatamente para UTF-8", () => {
    const mime = composeMimeMessage(message);
    expect(mime).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    expect(decodeSubject(mime)).toBe(PF_UPDATE_CAMPAIGN_SUBJECT);
    expect(mime).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(mime).toContain("Content-Type: text/html; charset=UTF-8");
  });
});
