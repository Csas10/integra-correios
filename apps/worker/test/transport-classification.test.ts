import { describe, expect, it } from "vitest";
import {
  GmailAmbiguousError,
  GmailAuthError,
  GmailPermanentPolicyError,
  GmailRateLimitError,
  MailProviderRequestError,
  composeMimeMessage,
} from "@integra-correios/mail";
import type { OutboundMail } from "@integra-correios/mail";
import { calcularRetryAt, mailFromPayload, sanitizarErro } from "../src/outbox.js";

// Massa 100% sintética; sem rede, sem Gmail real, sem PII.

const mensagemBase: OutboundMail = {
  idempotencyKey: "pf-pilot:CONF123",
  confirmationId: "CONF123",
  to: "profissional@exemplo.test",
  replyTo: "carteiras@crtba.org.br",
  subject: "Confirmação cadastral",
  textBody: "linha",
  htmlBody: "<p>linha</p>",
  templateVersion: "pf-pilot-crtba-v1",
};

describe("Seção 7 — classes de transporte especializam o erro sanitizado", () => {
  it("todas as classes Gmail são MailProviderRequestError (contrato homologado preservado)", () => {
    for (const erro of [
      new GmailAuthError("messages.send"),
      new GmailAmbiguousError("messages.send"),
      new GmailRateLimitError("messages.send"),
      new GmailPermanentPolicyError("messages.send"),
    ]) {
      expect(erro).toBeInstanceOf(MailProviderRequestError);
    }
  });

  it("sanitizarErro classifica por classe específica antes da mensagem", () => {
    expect(sanitizarErro(new GmailAuthError("messages.send"))).toBe("AUTH_REQUIRED");
    expect(sanitizarErro(new GmailPermanentPolicyError("messages.send"))).toBe("FAILED_PERMANENT");
    expect(sanitizarErro(new GmailRateLimitError("messages.send"))).toBe("RATE_LIMITED");
    expect(sanitizarErro(new GmailAmbiguousError("messages.send"))).toBe("DELIVERY_UNKNOWN");
  });
});

describe("Seção 7 — política de retry por código", () => {
  const agora = new Date("2026-09-22T12:00:00Z");

  it("DELIVERY_UNKNOWN e AUTH_REQUIRED não têm retry automático no piloto", () => {
    for (const codigo of ["DELIVERY_UNKNOWN", "AUTH_REQUIRED"]) {
      const retryAt = calcularRetryAt(codigo, 1, agora);
      expect(retryAt.getTime() - agora.getTime()).toBe(30 * 24 * 3_600_000);
    }
  });

  it("RATE_LIMITED usa backoff exponencial truncado com jitter; MAX_TENTATIVAS tem precedência", () => {
    const t1 = calcularRetryAt("RATE_LIMITED", 1, agora).getTime() - agora.getTime();
    // backoff = min(2^1 * 60s, 30min) = 2min; jitter [0, 30s)
    expect(t1).toBeGreaterThanOrEqual(2 * 60_000);
    expect(t1).toBeLessThanOrEqual(2 * 60_000 + 30_000);

    const t2 = calcularRetryAt("RATE_LIMITED", 2, agora).getTime() - agora.getTime();
    // backoff = min(2^2 * 60s, 30min) = 4min; jitter [0, 30s)
    expect(t2).toBeGreaterThanOrEqual(4 * 60_000);
    expect(t2).toBeLessThanOrEqual(4 * 60_000 + 30_000);

    // Na 3ª tentativa (>= MAX_TENTATIVAS), a precedência do limite estende o retry.
    const t3 = calcularRetryAt("RATE_LIMITED", 3, agora).getTime() - agora.getTime();
    expect(t3).toBe(30 * 24 * 3_600_000);
  });

  it("falha comum: retry curto até MAX_TENTATIVAS, depois estenso", () => {
    const curto = calcularRetryAt("PROVIDER_ERROR", 1, agora).getTime() - agora.getTime();
    expect(curto).toBe(5 * 60_000);

    const longo = calcularRetryAt("PROVIDER_ERROR", 99, agora).getTime() - agora.getTime();
    expect(longo).toBe(30 * 24 * 3_600_000);
  });
});

describe("Seção 6 — MIME da comunicação PF", () => {
  const payloadBase = {
    confirmationId: "CONF-SINT-001",
    destinatario: "profissional@exemplo.test",
    confirmationBaseUrl: "https://preview.exemplo.test",
    plainToken: "tok-sintetico",
    nome: "Nome Sintético",
    enderecoApresentado: "ENDEREÇO NÃO INFORMADO",
    telefone: "071 99999-0000",
  };

  it("escape HTML: conteúdo do XLSX nunca injeta marcação", () => {
    const m = mailFromPayload({
      ...payloadBase,
      nome: 'Ana <script>alert("x")</script>',
      enderecoApresentado: "Rua & <b>invadida</b>",
    });
    expect(m.htmlBody).not.toContain("<script>");
    expect(m.htmlBody).not.toContain("<b>invadida</b>");
    expect(m.htmlBody).toContain("&lt;script&gt;");
    expect(m.htmlBody).toContain("&amp;");
    // Assunto nunca carrega PII (sem nome, CPF, telefone, endereço).
    expect(m.subject).not.toContain("Ana");
    const mime = composeMimeMessage(m);
    expect(mime).toContain("Subject:");
  });

  it("Message-ID determinístico por confirmation_id e sem caracteres fora do msg-id", () => {
    const m1 = mailFromPayload(payloadBase);
    const mime1 = composeMimeMessage(m1);
    const linha1 = mime1.split("\r\n").find((l) => l.startsWith("Message-ID:"));
    expect(linha1).toBeDefined();
    const id1 = linha1!.slice("Message-ID: <".length, -1);
    expect(id1).toBe(`${m1.confirmationId.replace(/[^a-zA-Z0-9]/g, "")}.pf-confirmation@pilot.crtba.org.br`);
    // Determinístico: mesma confirmationId → mesmo Message-ID (randomBytes só no boundary).
    const mime2 = composeMimeMessage({ ...m1 });
    const id2 = mime2
      .split("\r\n")
      .find((l) => l.startsWith("Message-ID:"))!
      .slice("Message-ID: <".length, -1);
    expect(id2).toBe(id1);
  });
});
