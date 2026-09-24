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
    let chamadasFetch = 0;
    const espiarFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      chamadasFetch += 1;
      return new Response(JSON.stringify({ access_token: "x", expires_in: 3600 }), { status: 200 });
    });
    const contadores = gatewayComGateRecusado();
    await new Promise((resolve) => setTimeout(resolve, 10));
    espiarFetch.mockRestore();
    expect(contadores.recusas).toBe(1);
    expect(contadores.refrescos).toBe(0);
    expect(contadores.transportes).toBe(0);
    expect(chamadasFetch).toBe(0); // ZERO rede: nem oauth2/token, nem messages.send
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
    // (nenhuma credencial verdadeira é usada). Uma resposta nova por chamada,
    // com contagem explícita por endpoint.
    let chamadasToken = 0;
    let chamadasSend = 0;
    const espiarFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const endereco = String(url);
      if (endereco.includes("oauth2.googleapis.com")) {
        chamadasToken += 1;
        return new Response(JSON.stringify({ access_token: "token-renovado-sintetico", expires_in: 3600 }), { status: 200 });
      }
      if (endereco.includes("gmail.googleapis.com")) {
        chamadasSend += 1;
        return new Response(JSON.stringify({ id: `msg-sintetica-${chamadasSend}`, threadId: `thr-sintetica-${chamadasSend}` }), { status: 200 });
      }
      throw new Error(`endpoint inesperado no teste: ${endereco}`);
    });
    try {
      const envios = await (gateway as unknown as {
        send: (m: unknown) => Promise<{ provider: string }>;
      }).send(mensagem);
      expect(envios.provider).toBe("GMAIL");
    } finally {
      espiarFetch.mockRestore();
    }
    expect(refrescos).toBe(1);
    expect(ordem[0]).toBe("gate"); // gate ANTES de qualquer acesso a token
    expect(ordem).toContain("refresh");
    expect(ordem.indexOf("gate")).toBeLessThan(ordem.indexOf("refresh"));
    // Contagem explícita: exatamente 1 refresh; NO MÁXIMO 1 messages.send
    // (run-once, sem loop, sem retry).
    expect(chamadasToken).toBe(1);
    expect(chamadasSend).toBeLessThanOrEqual(1);
    expect(chamadasSend).toBe(1);
  });

  it("gate rejeitado → ZERO chamadas de rede (nem token, nem messages.send)", async () => {
    let chamadasFetch = 0;
    const espiarFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      chamadasFetch += 1;
      return new Response(JSON.stringify({ access_token: "x", expires_in: 3600 }), { status: 200 });
    });
    const contadores = gatewayComGateRecusado();
    await new Promise((resolve) => setTimeout(resolve, 10));
    espiarFetch.mockRestore();
    expect(contadores.recusas).toBe(1);
    expect(contadores.refrescos).toBe(0);
    expect(chamadasFetch).toBe(0); // nenhuma chamada oauth2 ou gmail
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

/**
 * OUTBOX_GATE_CHAIN_FIX — estado persistido EXATO do incidente no Preview
 * (verificado read-only pelo titular):
 *   lote CONTROLLED_GMAIL_TEST ATIVO/LIVE_PILOT;
 *   comunicação b76a1e9b-a59d-4777-8777-c2e61536613c (sintética);
 *   outbox status=FAILED, ultimo_erro_codigo=FAILED_PERMANENT (linha LEGADA,
 *   gravada antes da classificação específica existir), tentativas=2;
 *   sem provider message/thread id; receipts GMAIL históricos existem em
 *   OUTRAS comunicações (lote DRY_RUN antigo) mas NÃO nesta;
 *   REAL_SEND_ENABLED=false.
 */
const COMUNICACAO_INCIDENTE = "b76a1e9b-a59d-4777-8777-c2e61536613c";
const OUTBOX_INCIDENTE = "8a000000-0000-4000-8000-0000000000ef";

type LinhaOutbox = Record<string, unknown>;

function criarPoolIncidente(opcoes: {
  recuperacoes: number;
  /** Mutação já aplicada (2ª chamada deve ver PENDING + evento gravado). */
  recuperada: boolean;
}): { pool: unknown; mutacoes: string[]; eventos: LinhaOutbox[] } {
  const mutacoes: string[] = [];
  const eventos: LinhaOutbox[] = [];
  const pool = {
    async connect() {
      return {
        async query(text: string, values: readonly unknown[] = []) {
          if (text.includes("BEGIN")) return { rows: [], rowCount: 0 };
          if (text.includes("COMMIT") || text.includes("ROLLBACK")) {
            return { rows: [], rowCount: 0 };
          }
          if (text.includes("FROM outbox_email o") && text.includes("FOR UPDATE")) {
            return {
              rows: [
                {
                  outbox_id: OUTBOX_INCIDENTE,
                  comunicacao_id: COMUNICACAO_INCIDENTE,
                  // Estado legado: PENDING quando a recuperação já mutou.
                  outbox_status: opcoes.recuperada ? "PENDING" : "FAILED",
                  tentativas: 2,
                  erro: opcoes.recuperada ? null : "FAILED_PERMANENT",
                  lote_status: "ATIVO",
                  lote_modo: "LIVE_PILOT",
                  receipts_comunicacao: "0",
                  provider_ids: "0",
                  recuperacoes: String(opcoes.recuperacoes),
                  pendente_fora: "0",
                  processamento: "0",
                  ativos_fora: "0",
                },
              ],
              rowCount: 1,
            };
          }
          if (text.includes("FROM evento_auditoria ea") && text.includes("count(*)")) {
            // Idempotência: evento com o comunicacao_id REAL quando já recuperado.
            return { rows: [{ total: opcoes.recuperada ? "1" : "0" }], rowCount: 1 };
          }
          if (text.includes("INSERT INTO evento_auditoria")) {
            eventos.push({
              tipo: values[3],
              agregado_tipo: values[1],
              agregado_id: values[2],
            });
            return { rows: [], rowCount: 1 };
          }
          if (text.includes("UPDATE outbox_email")) {
            mutacoes.push("outbox->PENDING");
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
  return { pool, mutacoes, eventos };
}

async function importarRepositorio() {
  const modulo = await import("@integra-correios/persistence");
  return modulo.PostgresOperationalRepository;
}

function comandoRecuperacao(operador: string) {
  const agora = new Date().toISOString();
  return {
    expectedCode: "CONTROLLED_GMAIL_TEST",
    expectedErrorCode: "FAILED_PERMANENT",
    expectedAttempts: 2,
    realSendEnabled: false,
    availableAt: agora,
    auditEvent: {
      id: `evento-${operador}`,
      aggregateType: "COMUNICACAO",
      aggregateId: "",
      type: "PF_CONTROLLED_GATE_OAUTH_RECOVERY_AUTORIZADO",
      occurredAt: agora,
      metadata: { motivo: "FAILED_PERMANENT", finalidade: "recuperacao-gate-pre-send" },
      eventHash: `hash-${operador}`,
    },
  };
}

describe("OUTBOX_GATE_CHAIN_FIX — recuperação do estado persistido exato do incidente", () => {
  it("linha legada FAILED/FAILED_PERMANENT/tentativas=2 é recuperada com evento vinculado à comunicação", async () => {
    const { pool, mutacoes, eventos } = criarPoolIncidente({ recuperacoes: 0, recuperada: false });
    const PostgresOperationalRepository = await importarRepositorio();
    const repositorio = new PostgresOperationalRepository(pool as never);
    const resultado = await repositorio.recuperarOutboxControlada(
      comandoRecuperacao("operador-1") as never,
    );
    expect(resultado.resultCode).toBe("RECOVERED");
    expect(resultado.outboxId).toBe(OUTBOX_INCIDENTE);
    expect(mutacoes).toEqual(["outbox->PENDING"]); // CAS exato: UMA mutação
    expect(eventos).toHaveLength(1);
    const evento = eventos[0]!;
    expect(evento.tipo).toBe("PF_CONTROLLED_GATE_OAUTH_RECOVERY_AUTORIZADO");
    // aggregateId REAL: a idempotência procura por este id.
    expect(evento.agregado_id).toBe(COMUNICACAO_INCIDENTE);
    expect(evento.agregado_tipo).toBe("COMUNICACAO");
  });

  it("idempotência REAL: segunda chamada com outbox PENDING + evento existente → ALREADY_RECOVERED sem mutação", async () => {
    const { pool, mutacoes, eventos } = criarPoolIncidente({ recuperacoes: 1, recuperada: true });
    const PostgresOperationalRepository = await importarRepositorio();
    const repositorio = new PostgresOperationalRepository(pool as never);
    const comando = comandoRecuperacao("operador-2");
    const resultado = await repositorio.recuperarOutboxControlada(comando as never);
    expect(resultado.resultCode).toBe("ALREADY_RECOVERED");
    expect(mutacoes).toEqual([]); // NENHUMA nova mutação
    expect(eventos).toEqual([]); // NENHUM novo evento
  });

  it("receipt na comunicação controlada bloqueia; receipt em OUTRA comunicação NÃO bloqueia", async () => {
    const mutacoes: string[] = [];
    const pool = {
      async connect() {
        return {
          async query(text: string) {
            if (text.includes("BEGIN") || text.includes("COMMIT")) return { rows: [], rowCount: 0 };
            if (text.includes("FROM outbox_email o") && text.includes("FOR UPDATE")) {
              return {
                rows: [
                  {
                    outbox_id: OUTBOX_INCIDENTE,
                    comunicacao_id: COMUNICACAO_INCIDENTE,
                    outbox_status: "FAILED",
                    tentativas: 2,
                    erro: "FAILED_PERMANENT",
                    lote_status: "ATIVO",
                    lote_modo: "LIVE_PILOT",
                    // Receipt histórico em OUTRA comunicação não aparece aqui:
                    // a contagem é por comunicação controlada.
                    receipts_comunicacao: "0",
                    provider_ids: "0",
                    recuperacoes: "0",
                    pendente_fora: "0",
                    processamento: "0",
                    ativos_fora: "0",
                  },
                ],
                rowCount: 1,
              };
            }
            if (text.includes("UPDATE outbox_email")) mutacoes.push("outbox->PENDING");
            return { rows: [], rowCount: 1 };
          },
          release() {},
        };
      },
    };
    const PostgresOperationalRepository = await importarRepositorio();
    const repositorio = new PostgresOperationalRepository(pool as never);
    const resultado = await repositorio.recuperarOutboxControlada(
      comandoRecuperacao("operador-3") as never,
    );
    expect(resultado.resultCode).toBe("RECOVERED");
    expect(mutacoes).toEqual(["outbox->PENDING"]);
  });

  it("outbox FAILED com outro código (DELIVERY_UNKNOWN) nunca é recuperável", async () => {
    const pool = {
      async connect() {
        return {
          async query(text: string) {
            if (text.includes("BEGIN") || text.includes("COMMIT")) return { rows: [], rowCount: 0 };
            if (text.includes("FROM outbox_email o") && text.includes("FOR UPDATE")) {
              return {
                rows: [
                  {
                    outbox_id: OUTBOX_INCIDENTE,
                    comunicacao_id: COMUNICACAO_INCIDENTE,
                    outbox_status: "FAILED",
                    tentativas: 2,
                    erro: "DELIVERY_UNKNOWN",
                    lote_status: "ATIVO",
                    lote_modo: "LIVE_PILOT",
                    receipts_comunicacao: "0",
                    provider_ids: "0",
                    recuperacoes: "0",
                    pendente_fora: "0",
                    processamento: "0",
                    ativos_fora: "0",
                  },
                ],
                rowCount: 1,
              };
            }
            return { rows: [], rowCount: 0 };
          },
          release() {},
        };
      },
    };
    const PostgresOperationalRepository = await importarRepositorio();
    const repositorio = new PostgresOperationalRepository(pool as never);
    await expect(
      repositorio.recuperarOutboxControlada(comandoRecuperacao("operador-4") as never),
    ).rejects.toThrow(/ERROR_CODE_MISMATCH/);
  });
});

/**
 * CORRECTIVE_LEGACY_INCIDENT_BINDING — o vínculo legado FAILED_PERMANENT fica
 * preso à comunicação EXATA do incidente (server-side): qualquer outra
 * comunicação do lote controlado com o mesmo status/código/tentativas é
 * RECUSADA sem mutação e sem auditoria; e exige o evento prévio
 * PF_CONTROLLED_RETRY_AUTORIZADO do lote.
 */
describe("CORRECTIVE_LEGACY_INCIDENT_BINDING — vínculo da recuperação legado", () => {
  function poolComComunicacao(
    comunicacaoId: string,
    opcoes: { retryAutorizado: number; codigoErro?: string } = { retryAutorizado: 1 },
  ) {
    const mutacoes: string[] = [];
    const eventos: LinhaOutbox[] = [];
    const pool = {
      async connect() {
        return {
          async query(text: string, values: readonly unknown[] = []) {
            if (text.includes("BEGIN") || text.includes("COMMIT") || text.includes("ROLLBACK")) {
              return { rows: [], rowCount: 0 };
            }
            if (text.includes("FROM outbox_email o") && text.includes("FOR UPDATE")) {
              return {
                rows: [
                  {
                    outbox_id: OUTBOX_INCIDENTE,
                    comunicacao_id: comunicacaoId,
                    outbox_status: "FAILED",
                    tentativas: 2,
                    erro: opcoes.codigoErro ?? "FAILED_PERMANENT",
                    lote_status: "ATIVO",
                    lote_modo: "LIVE_PILOT",
                    receipts_comunicacao: "0",
                    provider_ids: "0",
                    recuperacoes: "0",
                    retry_autorizado: String(opcoes.retryAutorizado),
                    pendente_fora: "0",
                    processamento: "0",
                    ativos_fora: "0",
                  },
                ],
                rowCount: 1,
              };
            }
            if (text.includes("INSERT INTO evento_auditoria")) {
              eventos.push({ tipo: values[3], agregado_id: values[2] });
              return { rows: [], rowCount: 1 };
            }
            if (text.includes("UPDATE outbox_email")) mutacoes.push("outbox->PENDING");
            return { rows: [], rowCount: 1 };
          },
          release() {},
        };
      },
    };
    return { pool, mutacoes, eventos };
  }

  function comandoLegado() {
    const comando = comandoRecuperacao("operador-legado") as {
      expectedCode: string;
      expectedErrorCode: string;
      expectedAttempts: number;
      expectedCommunicationId?: string;
      realSendEnabled: boolean;
      availableAt: string;
      auditEvent: Record<string, unknown>;
    };
    comando.expectedErrorCode = "FAILED_PERMANENT";
    // CORRECTIVE_LEGACY_INCIDENT_BINDING: server-side — o navegador nunca
    // fornece esse id.
    comando.expectedCommunicationId = COMUNICACAO_INCIDENTE;
    return comando;
  }

  it("a comunicação EXATA do incidente é recuperada", async () => {
    const { pool, mutacoes, eventos } = poolComComunicacao(COMUNICACAO_INCIDENTE);
    const PostgresOperationalRepository = await importarRepositorio();
    const repositorio = new PostgresOperationalRepository(pool as never);
    const resultado = await repositorio.recuperarOutboxControlada(comandoLegado() as never);
    expect(resultado.resultCode).toBe("RECOVERED");
    expect(resultado.outboxId).toBe(OUTBOX_INCIDENTE);
    expect(mutacoes).toEqual(["outbox->PENDING"]);
    expect(eventos).toHaveLength(1);
  });

  it("OUTRA comunicação com o mesmo status/código/tentativas é RECUSADA — sem mutação e sem auditoria", async () => {
    const { pool, mutacoes, eventos } = poolComComunicacao("99999999-9999-4999-8999-999999999999");
    const PostgresOperationalRepository = await importarRepositorio();
    const repositorio = new PostgresOperationalRepository(pool as never);
    await expect(
      repositorio.recuperarOutboxControlada(comandoLegado() as never),
    ).rejects.toThrow(/COMMUNICATION_MISMATCH/);
    expect(mutacoes).toEqual([]); // NENHUMA mutação na recusa
    expect(eventos).toEqual([]); // NENHUM evento de auditoria na recusa
  });

  it("sem PF_CONTROLLED_RETRY_AUTORIZADO prévio, a recuperação legado é RECUSADA", async () => {
    const { pool, mutacoes, eventos } = poolComComunicacao(COMUNICACAO_INCIDENTE, { retryAutorizado: 0 });
    const PostgresOperationalRepository = await importarRepositorio();
    const repositorio = new PostgresOperationalRepository(pool as never);
    await expect(
      repositorio.recuperarOutboxControlada(comandoLegado() as never),
    ).rejects.toThrow(/RETRY_AUTHORIZATION_MISSING/);
    expect(mutacoes).toEqual([]);
    expect(eventos).toEqual([]);
  });

  it("classificação específica CONTROLLED_GATE_OAUTH_NOT_READY segue SEM vínculo de comunicação", async () => {
    const { pool, mutacoes } = poolComComunicacao("99999999-9999-4999-8999-999999999999", {
      retryAutorizado: 1,
      codigoErro: "CONTROLLED_GATE_OAUTH_NOT_READY",
    });
    const PostgresOperationalRepository = await importarRepositorio();
    const repositorio = new PostgresOperationalRepository(pool as never);
    const comando = comandoRecuperacao("operador-especifico") as {
      expectedErrorCode: string;
      expectedCommunicationId?: string;
    };
    comando.expectedErrorCode = "CONTROLLED_GATE_OAUTH_NOT_READY";
    expect(comando.expectedCommunicationId).toBeUndefined(); // fluxo normal
    const resultado = await repositorio.recuperarOutboxControlada(comando as never);
    expect(resultado.resultCode).toBe("RECOVERED");
    expect(mutacoes).toEqual(["outbox->PENDING"]);
  });
});
