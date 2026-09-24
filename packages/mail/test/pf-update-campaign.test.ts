import { describe, expect, it } from "vitest";
import {
  composeMimeMessage,
  PF_UPDATE_CAMPAIGN_SUBJECT,
  PF_UPDATE_CAMPAIGN_TEMPLATE_VERSION,
  renderPfUpdateCampaignMail,
} from "../src/index.js";

function subjectPhysicalLines(mime: string): string[] {
  const lines = mime.split("\r\n");
  const start = lines.findIndex((line) => line.startsWith("Subject: "));
  if (start < 0) throw new Error("Subject ausente");

  const headerLines = [lines[start]!];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.startsWith(" ")) break;
    headerLines.push(line);
  }
  return headerLines;
}

function encodedSubjectWords(mime: string): string[] {
  const lines = subjectPhysicalLines(mime);
  const unfolded = lines
    .map((line, index) => index === 0 ? line.slice("Subject: ".length) : line.trimStart())
    .join(" ");
  return unfolded.split(/\s+/);
}

function decodeSubject(mime: string): string {
  return encodedSubjectWords(mime)
    .map((word) => {
      const match = /^=\?UTF-8\?B\?([^?]+)\?=$/.exec(word);
      if (!match?.[1]) throw new Error("Subject não está em RFC 2047 Base64 UTF-8");
      return Buffer.from(match[1], "base64").toString("utf8");
    })
    .join("");
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

  it("MIME faz folding do Subject RFC 2047 em linhas físicas de até 76 caracteres", () => {
    const mime = composeMimeMessage(message);
    const lines = subjectPhysicalLines(mime);
    const words = encodedSubjectWords(mime);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 76)).toBe(true);
    expect(words.length).toBeGreaterThan(1);
    expect(words.every((word) => word.length <= 75)).toBe(true);
    expect(words.every((word) => /^=\?UTF-8\?B\?[^?]+\?=$/.test(word))).toBe(true);
    expect(decodeSubject(mime)).toBe(PF_UPDATE_CAMPAIGN_SUBJECT);
    expect(mime).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(mime).toContain("Content-Type: text/html; charset=UTF-8");
  });
});
