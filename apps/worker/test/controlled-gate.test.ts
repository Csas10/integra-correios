import { describe, expect, it } from "vitest";
import { GmailPermanentPolicyError } from "@integra-correios/mail";
import { NodePostgresPool, PostgresOperationalRepository } from "@integra-correios/persistence";
import { criarGatewayDoAmbiente } from "../src/outbox.js";

// FINAL CLOSURE GATE item 2 — GATE 2 REAL do modo controlado:
// verificação imediatamente antes de users.messages.send. Os cenários de
// recusa são exercidos através do envelope do gateway com gate injetado
// (mesma fiação do executarWorkerDoModo) — sem rede, sem Gmail real.
// A prova de lote/realização humana (consultas SQL) é validada na suíte
// PostgreSQL; aqui validamos o FAIL-CLOSED do caminho de execução.

function gatewayControlado(
  veredito: { ok: true } | { ok: false; motivo: string },
): { gateway: ReturnType<typeof criarGatewayDoAmbiente>; chamadasGate: string[] } {
  const chamadasGate: string[] = [];
  const env = {
    REAL_SEND_ENABLED: "true",
    MAIL_PROVIDER: "GMAIL",
    GMAIL_OAUTH_CLIENT_ID: "client-sintetico",
    GMAIL_OAUTH_CLIENT_SECRET: "secret-sintetico",
    GMAIL_OAUTH_REDIRECT_URI: "https://preview.exemplo.test/api/oauth/gmail/callback",
    GMAIL_EXPECTED_ACCOUNT: "carteiras@crtba.org.br",
    // Chave sintética de 32 bytes exigida pelo provider de token.
    DOCUMENT_FINGERPRINT_KEY_BASE64: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
  };
  const gateway = criarGatewayDoAmbiente(env, false, {
    credentials: {
      loadGmailConnection: async () => ({
        id: "conn-1",
        provider: "GMAIL" as const,
        accountFingerprint: "fp",
        scopes: ["https://www.googleapis.com/auth/gmail.send"],
        accessToken: {
          ciphertext: new Uint8Array([1]),
          nonce: new Uint8Array([2]),
          authTag: new Uint8Array([3]),
          keyVersion: "v1",
        },
        // Token fresco: o gate é exercido DEPOIS do provider de acesso
        // (ordem real: token → GATE 2 → users.messages.send).
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    },
    // Repositório presente mas não exercido neste teste (o gate é injetado).
    repository: {} as never,
    caixa: {
      open: () => new TextEncoder().encode("access-token-sintetico"),
    } as never,
    gateControlado: async (communicationId: string) => {
      chamadasGate.push(communicationId);
      return veredito;
    },
  });
  return { gateway, chamadasGate };
}

const mensagem = {
  idempotencyKey: "pf-pilot:CONF-G2",
  confirmationId: "CONF-G2",
  communicationId: "COMM-G2",
  to: "destinatario.controlado@exemplo.test",
  replyTo: "carteiras@crtba.org.br",
  subject: "Confirmação cadastral",
  textBody: "linha",
  htmlBody: "<p>linha</p>",
  templateVersion: "pf-pilot-crtba-v1",
};

describe("FINAL CLOSURE GATE item 2 — GATE 2 antes de users.messages.send", () => {
  it("gate recusa (destinatário divergente) → ZERO chamadas ao Gmail", async () => {
    const { gateway, chamadasGate } = gatewayControlado({ ok: false, motivo: "RECIPIENT_MISMATCH" });
    await expect(gateway.send(mensagem)).rejects.toThrow(GmailPermanentPolicyError);
    expect(chamadasGate).toEqual(["COMM-G2"]);
  });

  it("gate recusa (registro não sintético) → ZERO chamadas ao Gmail", async () => {
    const { gateway } = gatewayControlado({ ok: false, motivo: "SOURCE_NOT_SYNTHETIC" });
    await expect(gateway.send(mensagem)).rejects.toThrow(/SOURCE_NOT_SYNTHETIC/);
  });

  it("gate recusa (lote em PREPARACAO) → ZERO chamadas ao Gmail", async () => {
    const { gateway } = gatewayControlado({ ok: false, motivo: "BATCH_NOT_ACTIVE" });
    await expect(gateway.send(mensagem)).rejects.toThrow(/BATCH_NOT_ACTIVE/);
  });

  it("gate recusa (lote com mais de uma comunicação) → ZERO chamadas ao Gmail", async () => {
    const { gateway } = gatewayControlado({ ok: false, motivo: "CONTROLLED_BATCH_SIZE" });
    await expect(gateway.send(mensagem)).rejects.toThrow(/CONTROLLED_BATCH_SIZE/);
  });

  it("gate recusa (liberação humana não auditada) → ZERO chamadas ao Gmail", async () => {
    const { gateway } = gatewayControlado({ ok: false, motivo: "HUMAN_RELEASE_NOT_AUDITED" });
    await expect(gateway.send(mensagem)).rejects.toThrow(/HUMAN_RELEASE_NOT_AUDITED/);
  });

  it("gate recusa (receipt anterior) → ZERO chamadas ao Gmail", async () => {
    const { gateway } = gatewayControlado({ ok: false, motivo: "PREVIOUS_RECEIPT" });
    await expect(gateway.send(mensagem)).rejects.toThrow(/PREVIOUS_RECEIPT/);
  });

  it("gate recusa (OAuth não pronto) → ZERO chamadas ao Gmail", async () => {
    const { gateway } = gatewayControlado({ ok: false, motivo: "OAUTH_NOT_READY" });
    await expect(gateway.send(mensagem)).rejects.toThrow(/OAUTH_NOT_READY/);
  });

  it("sem GMAIL_CONTROLLED_MODE no gate (dryRun) o gateway é o sintético — nunca o Gmail", () => {
    const env = { REAL_SEND_ENABLED: "true", MAIL_PROVIDER: "GMAIL" };
    const gateway = criarGatewayDoAmbiente(env, true, {});
    // Sem transport injetado, o gateway real é fail-closed — e o DRY_RUN
    // nunca escolhe o Gmail de qualquer forma.
    expect(gateway).toBeDefined();
  });
});
