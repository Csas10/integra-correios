import { describe, expect, it } from "vitest";
import {
  composeMimeMessage,
  PILOT_SENDER,
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
    remetente: { name: "CRT-BA | Carteiras Profissionais", address: "carteiras@crtba.org.br" },
    messageTag: "pf-campanha",
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

describe("Slice-03C.2A — desacoplamento do piloto e hardening MIME", () => {
  const remetenteSintetico = { name: "CRT-BA | Carteiras Profissionais", address: "carteiras@crtba.org.br" };

  function render(overrides: Partial<Parameters<typeof renderPfUpdateCampaignMail>[0]> = {}) {
    return renderPfUpdateCampaignMail({
      campaignId: "camp-002",
      itemId: "item-002",
      professionalId: "registro-2002",
      recipient: "destinatario.sintetico@exemplo.test",
      professionalName: "Bruno Teste",
      correlationCode: "PF26-DEADBEEF00112233445566778899AABB",
      remetente: remetenteSintetico,
      messageTag: "pf-campanha",
      ...overrides,
    });
  }

  it("From e Reply-To vêm da identidade injetada server-side (não do piloto)", () => {
    const m = render({ remetente: { name: "Remetente Sintético", address: "campanha@exemplo.test" } });
    expect(m.from).toEqual({ name: "Remetente Sintético", address: "campanha@exemplo.test" });
    expect(m.replyTo).toBe("campanha@exemplo.test");
    const mime = composeMimeMessage(m);
    expect(mime).toContain("From: Remetente Sintético <campanha@exemplo.test>");
    expect(mime).toContain("Reply-To: campanha@exemplo.test");
  });

  it("Message-ID da campanha deriva do domínio DO REMETENTE — nunca domínio hardcoded do piloto", () => {
    const m = render({ remetente: { name: "Remetente Sintético", address: "campanha@exemplo.test" } });
    const mime = composeMimeMessage(m);
    const messageId = /^Message-ID: <([^>]+)>$/m.exec(mime)?.[1] ?? "";
    expect(messageId).toContain("@exemplo.test");
    expect(messageId).toContain(".pf-campanha@");
    expect(mime).not.toContain("@pilot.crtba.org.br");
  });

  it("comportamento LEGADO do piloto preservado (mensagem sem from ⇒ PILOT_SENDER)", () => {
    const legado = {
      idempotencyKey: "piloto:item:legado",
      confirmationId: "itemlegado",
      to: "destinatario.sintetico@exemplo.test",
      replyTo: PILOT_SENDER.address,
      subject: "Assunto piloto",
      textBody: "texto",
      htmlBody: "<p>texto</p>",
      templateVersion: "pf-pilot-crtba-v1",
    };
    const mime = composeMimeMessage(legado);
    expect(mime).toContain(`From: ${PILOT_SENDER.name} <${PILOT_SENDER.address}>`);
    expect(mime).toContain("Reply-To: " + PILOT_SENDER.address);
    expect(mime).toContain("@pilot.crtba.org.br");
  });

  it("CR/LF injection bloqueada no correlationCode e no remetente", () => {
    expect(() => render({ correlationCode: "PF26\r\nBcc: alvo@exemplo.test" })).toThrow();
    expect(() => render({ remetente: { name: "X\r\nBcc: alvo@exemplo.test", address: "carteiras@crtba.org.br" } })).toThrow();
    expect(() => render({ remetente: { name: "Y", address: "carteiras\n@crtba.org.br" } })).toThrow();
  });

  it("escaping de HTML no nome e ausência de script/executáveis", () => {
    const m = render({ professionalName: 'Ana <script>alert(1)</script> & "Silva"' });
    expect(m.htmlBody).not.toContain("<script>");
    expect(m.htmlBody).toContain("&lt;script&gt;");
    expect(m.textBody).toContain('Ana <script>alert(1)</script> & "Silva"');
  });

  it("sem CPF, sem fingerprint, sem secrets, sem token, sem headers do cliente", () => {
    const m = render();
    const mime = composeMimeMessage(m);
    for (const superficie of [m.textBody, m.htmlBody, mime]) {
      expect(superficie).not.toMatch(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/); // CPF
      expect(superficie).not.toMatch(/\b[0-9a-f]{64}\b/); // fingerprint/sha
      expect(superficie).not.toMatch(/Bearer\s/i); // token
      expect(superficie.toLowerCase()).not.toContain("client_secret");
      expect(superficie.toLowerCase()).not.toContain("refresh_token");
    }
    // O Subject é a constante institucional — NUNCA derivado da entrada
    // (nome/destinatário/correlationCode diferentes produzem o MESMO subject).
    expect(render({ professionalName: "Outro Nome", recipient: "outro@exemplo.test" }).subject).toBe(
      PF_UPDATE_CAMPAIGN_SUBJECT,
    );
    expect(m.subject).toBe(PF_UPDATE_CAMPAIGN_SUBJECT);
  });

  it("idempotencyKey e Protocolo (correlationCode) presentes e estáveis", () => {
    const a = render();
    const b = render();
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.textBody).toContain("Protocolo: PF26-DEADBEEF00112233445566778899AABB");
    expect(a.htmlBody).toContain("PF26-DEADBEEF00112233445566778899AABB");
  });

  it("texto e HTML presentes (multipart/alternative)", () => {
    const mime = composeMimeMessage(render());
    expect(mime).toContain("Content-Type: multipart/alternative");
    expect(mime).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(mime).toContain("Content-Type: text/html; charset=UTF-8");
  });
});
