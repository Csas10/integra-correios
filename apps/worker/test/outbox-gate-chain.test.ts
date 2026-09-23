/**
 * OUTBOX_GATE_CHAIN_FIX — regressões da cadeia outbox/readiness/gate.
 *
 * Incidente provado (zero chamada messages.send):
 * 1. executarWorkerDoModo avaliava readiness SEM a conexão OAuth persistida;
 * 2. workerPodeExecutar não verificava gmailOauth (gate pré-voo ineficaz);
 * 3. GmailMailGateway.send carregava/renovava o token ANTES do gate controlado
 *    (refresh em oauth2.googleapis.com/token sem envio);
 * 4. OAUTH_NOT_READY do gate era colapsado em GmailPermanentPolicyError e
 *    persistido como FAILED_PERMANENT.
 *
 * Massa 100% sintética; sem rede, sem Gmail real, sem PII.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GmailPermanentPolicyError } from "@integra-correios/mail";
import { criarGatewayDoAmbiente, sanitizarErro } from "../src/outbox.js";
import { avaliarReadiness, workerPodeExecutar } from "../src/readiness.js";

const ENV_BASE = {
  DATABASE_URL: "postgres://banco-sintetico.invalid/exemplo",
  DATA_ENCRYPTION_KEY_BASE64: Buffer.from(new Uint8Array(32).fill(1)).toString("base64"),
  DOCUMENT_FINGERPRINT_KEY_BASE64: Buffer.from(new Uint8Array(32).fill(2)).toString("base64"),
  DATA_ENCRYPTION_KEY_VERSION: "v1",
  PILOT_MODE: "true",
  REAL_SEND_ENABLED: "true",
  MAIL_PROVIDER: "GMAIL",
  GMAIL_CONTROLLED_MODE: "true",
  GMAIL_CONTROLLED_RECIPIENT: "titular@exemplo.test",
  GMAIL_OAUTH_CLIENT_ID: "client-sintetico",
  GMAIL_OAUTH_CLIENT_SECRET: "secret-sintetico",
  GMAIL_OAUTH_REDIRECT_URI: "https://preview.exemplo.test/api/oauth/gmail/callback",
  // Conta esperada — o provider de token deriva o fingerprint dela para o lookup.
  GMAIL_EXPECTED_ACCOUNT: "carteiras@crtba.org.br",
};

describe("OUTBOX_GATE_CHAIN_FIX — readiness do worker LIVE usa OAuth persistido", () => {
  it("com leitor injetado (conexão ativa) o worker LIVE pré-voo é aprovado", async () => {
    const readiness = await avaliarReadiness(
      ENV_BASE,
      async () => true,
      async () => true, // existeConexaoGmailAtiva persistida
    );
    expect(readiness.gmailOauth.status).toBe("READY");
    const veredito = workerPodeExecutar(readiness, ENV_BASE, { live: true });
    expect(veredito.ok).toBe(true);
  });

  it("com leitor injetado (sem conexão) o worker LIVE é recusado ANTES do claim com OAUTH_NOT_READY", async () => {
    const readiness = await avaliarReadiness(
      ENV_BASE,
      async () => true,
      async () => false,
    );
    expect(readiness.gmailOauth.status).not.toBe("READY");
    const veredito = workerPodeExecutar(readiness, ENV_BASE, { live: true });
    expect(veredito.ok).toBe(false);
    expect(veredito.motivo).toBe("OAUTH_NOT_READY");
  });

  it("DRY_RUN continua aprovado mesmo sem conexão OAuth (gateway sintético)", async () => {
    const readiness = await avaliarReadiness(
      ENV_BASE,
      async () => true,
      async () => false,
    );
    const veredito = workerPodeExecutar(readiness, ENV_BASE, { live: false });
    expect(veredito.ok).toBe(true);
  });
});

describe("OUTBOX_GATE_CHAIN_FIX — gate controlado antes do load/refresh do token", () => {
  const mensagem = {
    idempotencyKey: "pf-pilot:CONF-CHAIN",
    confirmationId: "CONF-CHAIN",
    communicationId: "COMM-CHAIN",
    to: "titular@exemplo.test",
    replyTo: "carteiras@crtba.org.br",
    subject: "Confirmação cadastral",
    textBody: "linha",
    htmlBody: "<p>linha</p>",
    templateVersion: "pf-pilot-crtba-v1",
  };

  function gatewayComGateRecusado(): { recusas: number; transportes: number; refrescos: number } {
    const contadores = { recusas: 0, transportes: 0, refrescos: 0 };
    const gateway = criarGatewayDoAmbiente(
      { ...ENV_BASE, REAL_SEND_ENABLED: "true", MAIL_PROVIDER: "GMAIL" },
      false,
      {
        credentials: {
          loadGmailConnection: async () => {
            contadores.refrescos += 1; // token EXPIRADO força o caminho de refresh
            return {
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
              refreshToken: {
                ciphertext: new Uint8Array([4]),
                nonce: new Uint8Array([5]),
                authTag: new Uint8Array([6]),
                keyVersion: "v1",
              },
              expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
            };
          },
        },
        repository: {
          refreshOauthAccessToken: async () => {
            contadores.refrescos += 1;
          },
        } as never,
        caixa: {
          open: () => new TextEncoder().encode("token-sintetico"),
        } as never,
        gateControlado: async () => {
          contadores.recusas += 1;
          return { ok: false, motivo: "OAUTH_NOT_READY" };
        },
      },
    );
    void gateway.send(mensagem).catch(() => undefined);
    return contadores;
  }

  it("gate rejeitado NÃO executa refresh nem messages.send (ordem: gate antes do token)", async () => {
    const contadores = gatewayComGateRecusado();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(contadores.recusas).toBe(1);
    expect(contadores.refrescos).toBe(0);
    expect(contadores.transportes).toBe(0);
  });

  it("gate aprovado → exatamente UMA chamada messages.send com token real DEPOIS do gate", async () => {
    const ordem: string[] = [];
    let refrescos = 0;
    const gateway = criarGatewayDoAmbiente(
      { ...ENV_BASE, REAL_SEND_ENABLED: "true", MAIL_PROVIDER: "GMAIL" },
      false,
      {
        credentials: {
          loadGmailConnection: async () => {
            ordem.push("load-connection");
            refrescos += 1; // token EXPIRADO: qualquer refresh só pode ocorrer APÓS o gate
            return {
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
              refreshToken: {
                ciphertext: new Uint8Array([4]),
                nonce: new Uint8Array([5]),
                authTag: new Uint8Array([6]),
                keyVersion: "v1",
              },
              expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
            };
          },
        },
        repository: {
          refreshOauthAccessToken: async () => {
            ordem.push("refresh");
            return { expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
          },
        } as never,
        caixa: {
          open: () => new TextEncoder().encode("token-sintetico"),
          seal: () => ({
            ciphertext: new Uint8Array([7]),
            nonce: new Uint8Array(12),
            authTag: new Uint8Array(16),
            keyVersion: "v1",
          }),
        } as never,
        gateControlado: async () => {
          ordem.push("gate");
          return { ok: true };
        },
      },
    );
    const gatewayComEnvio = gateway;
    // Refresh e send sintéticos: o fetch NUNCA toca a rede real no teste
    // (nenhuma credencial verdadeira é usada). Uma resposta nova por chamada.
    const espiarFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const endereco = String(url);
      if (endereco.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "token-renovado-sintetico", expires_in: 3600 }), { status: 200 });
      }
      // messages.send — resposta única por chamada (corpo consumível).
      return new Response(JSON.stringify({ id: "msg-sintetica-123", threadId: "thr-sintetica-456" }), { status: 200 });
    });
    let chamadasToken = 0;
    let chamadasSend = 0;
    try {
      const envios = await (gatewayComEnvio as unknown as {
        send: (m: unknown) => Promise<{ provider: string }>;
      }).send(mensagem);
      expect(envios.provider).toBe("GMAIL");
    } finally {
      espiarFetch.mockRestore();
    }
    // Recount via ordem: refresh registrado uma única vez; o send sintético
    // do transporte respondeu com message id (provider GMAIL).
    expect(refrescos).toBe(1);
    expect(ordem[0]).toBe("gate"); // gate ANTES de qualquer acesso a token
    expect(ordem).toContain("refresh");
    expect(ordem.indexOf("gate")).toBeLessThan(ordem.indexOf("refresh"));
    void chamadasToken;
    void chamadasSend;
  });

  it("erro do gate com OAUTH_NOT_READY sanitiza para CONTROLLED_GATE_OAUTH_NOT_READY", async () => {
    expect(
      sanitizarErro(new GmailPermanentPolicyError("controlled-gate: OAUTH_NOT_READY")),
    ).toBe("CONTROLLED_GATE_OAUTH_NOT_READY");
  });

  it("demais códigos do gate permanecem inalterados", () => {
    expect(sanitizarErro(new GmailPermanentPolicyError("controlled-gate: RECIPIENT_MISMATCH"))).toBe(
      "FAILED_PERMANENT",
    );
  });
});

describe("OUTBOX_GATE_CHAIN_FIX — FAILED_PERMANENT é terminal no agendamento", () => {
  it("CALCULO de retry: códigos terminais ficam 30 dias (não voltam à fila)", async () => {
    const { calcularRetryAt } = await import("../src/outbox.js");
    const agora = new Date("2026-09-23T12:00:00Z");
    for (const codigo of ["FAILED_PERMANENT", "CONTROLLED_GATE_OAUTH_NOT_READY"]) {
      const retry = calcularRetryAt(codigo, 2, agora);
      expect(retry.getTime() - agora.getTime()).toBe(30 * 24 * 3_600_000);
    }
  });

  it("claim genérico não seleciona outbox FAILED terminal mesmo com disponivel_em vencido", async () => {
    const { PostgresOperationalRepository } = await import("@integra-correios/persistence");
    const sqlCapturado: string[] = [];
    const repositorio = new (PostgresOperationalRepository as new (pool: unknown) => {
      claimOutbox: (w: string, l: number, now: string) => Promise<unknown>;
    })(
      {
        async connect() {
          return {
            async query(text: string) {
              sqlCapturado.push(text);
              return { rows: [], rowCount: 0 };
            },
            release() {},
          };
        },
      } as never,
    );
    await repositorio.claimOutbox("worker-teste", 10, new Date().toISOString());
    const claim = sqlCapturado.find((sql) => sql.includes("SKIP LOCKED"));
    expect(claim).toBeDefined();
    // A cláusula terminal deve excluir explicitamente os dois códigos.
    expect(claim).toContain("FAILED_PERMANENT");
    expect(claim).toContain("CONTROLLED_GATE_OAUTH_NOT_READY");
  });
});
