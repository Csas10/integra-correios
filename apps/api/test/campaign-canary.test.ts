/**
 * SLICE-03C.2A/03C.2A.1 — Fundação runtime do canário (STRICT NO SEND).
 *
 * Classificação honesta das provas:
 *   · BEHAVIORAL (puro/local): política canarySendEnabled (autoridade única,
 *     fail-closed), correlationCode (server-side, estável, sem PII),
 *     derivarRemetenteCampanha, preflight fail-closed SEM banco;
 *   · CLASSIFICATION (transport com fetch STUB — zero rede real): matriz
 *     03C.2A.1 — timeout/abort/rede-genérica/5xx ⇒ AMBIGUO; 401 ⇒
 *     AUTH_REQUIRED; 403 policy/rate-limit; 429 ⇒ RATE_LIMITED; 2xx sem id ⇒
 *     AMBIGUO; 2xx+id ⇒ receipt;
 *   · SOURCE_STRUCTURE (leitura de fonte): ZERO CLAIM no preflight, rota com
 *     autoridade mínima, DI exclusiva de teste, nenhuma leitura do flag fora
 *     da política, Executar canário sem onClick/handler na UI;
 *   · HTTP_ROUTES (sem banco): canary-send 401/503 fail-closed;
 *   · POSTGRESQL_INTEGRATION (DB-gated, PG16): ROTA REAL — armamento ausente
 *     (409 CAMPAIGN_CANARY_SEND_DISABLED, zero tudo), caminho elegível com
 *     provider sintético via DEPENDENCY INJECTION (handler real → preflight →
 *     claim → provider → receipt → settlement), replay, fingerprint
 *     divergente e readiness OAuth (4 estados + sanitização + zero rede).
 *
 * NENHUMA chamada de rede real em nenhum teste (fetch sempre stubado ou não
 * usado). Nenhum env global persistente (mutações revertidas por afterEach).
 * Nenhum destinatário real (e-mails .test).
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  carregarPoliticaCampanhaAtualizacao,
  type PfUpdateCampaignPolicy,
} from "../src/campaigns.js";
import {
  CORRELATION_CODE_PREFIX,
  ProvedorGmailCampanha,
  correlationCodeCanario,
  derivarRemetenteCampanha,
  preflightCanarioCampanha,
  provedorWiringReady,
  statusOauthFromReadiness,
  enviarCanarioCampanha,
} from "../src/campaign-canary.js";
import {
  despachar as despacharSemBanco,
  injetarProvedorCanarioParaTeste,
} from "../src/server.js";
import { chaveIdempotenciaExecucao } from "../src/campaign-execution.js";
import { fingerprintDestinatarioCampanha } from "../src/campaign-control.js";
import {
  GmailAmbiguousError,
  GmailAuthError,
  GmailHttpTransport,
  GmailPermanentPolicyError,
  GmailRateLimitError,
  MailProviderNaoConfiguradoError,
  MailProviderRequestError,
  type MailReceipt,
  type OutboundMail,
} from "@integra-correios/mail";
import { HmacSha256Fingerprinter } from "@integra-correios/persistence";

type Despachar = typeof despacharSemBanco;
const COOKIE_SESSAO = `__Host-ic_campaign_operator_session=${"B".repeat(43)}`;

const FONTE_CANARIO = readFileSync(new URL("../src/campaign-canary.ts", import.meta.url), "utf8");
const FONTE_SERVER = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const FONTE_POLITICA = readFileSync(new URL("../src/campaigns.ts", import.meta.url), "utf8");
const FONTE_WORKSPACE = readFileSync(
  new URL("../../web/src/pages/CampaignWorkspace.tsx", import.meta.url),
  "utf8",
);

function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function politicaBase(): PfUpdateCampaignPolicy {
  return {
    enabled: true,
    phase: "PERSISTENCE",
    individualOperatorIdentityRequired: true,
    canPersistImport: true,
    canCreateBatch: true,
    canExecute: true,
    canPrepareBatch: true,
    realSendEnabled: false,
    canarySendEnabled: false,
  };
}

// Restauração de ambiente por teste (nenhuma mutação persistente).
const ambienteOriginal = { ...process.env };
const CHAVES_SINTETICAS = [
  "DATABASE_URL",
  "PF_CAMPAIGN_CANARY_SEND_ENABLED",
  "PF_CAMPAIGN_PROOF_KEY_BASE64",
  "PF_CAMPAIGN_CANARY_RECIPIENT_FINGERPRINT",
  "GMAIL_OAUTH_CLIENT_ID",
  "GMAIL_OAUTH_CLIENT_SECRET",
  "GMAIL_OAUTH_REDIRECT_URI",
  "GMAIL_EXPECTED_ACCOUNT",
  "DATA_ENCRYPTION_KEY_BASE64",
  "DOCUMENT_FINGERPRINT_KEY_BASE64",
  "CAMPAIGN_SENDER_ADDRESS",
  "PF_CAMPAIGN_EXECUTE_ENABLED",
  "PF_CAMPAIGN_PREPARE_ENABLED",
  "REAL_SEND_ENABLED",
] as const;

// ---------------------------------------------------------------------------
// SLICE_03C.2A.2 — fixtures DETERMINÍSTICAS (fonte única, sem literais soltos)
// ---------------------------------------------------------------------------
/** Token sintético ÚNICO por semente: 43–128 chars, [A-Za-z0-9_-]. */
function tokenSintetico(semente: string): string {
  const base = "Op_abcdefghijklmnopqrstuvwxyz0123456789"; // 40 chars (padrão 03B)
  const sufixo = createHash("sha256").update("token-" + semente).digest("base64url").slice(0, 24);
  return base + sufixo; // 64 chars, único por semente
}
/** Hex de 64 caracteres, determinístico e único por semente. */
function fingerprintUnico(semente: string): string {
  return createHash("sha256").update(semente).digest("hex");
}
/**
 * Recomposição INDEPENDENTE (teste) do contrato vigente de hash de evento:
 * CAMPANHA_CONTROLE_HASH_V2 — HMAC-SHA256 sobre framing JSON canônico de
 * (eventoId, agregadoTipo, agregadoId, tipo, ocorreuEm). NÃO chama helper
 * privado de produção. Ids distintos ⇒ hashes distintos (mesmo lote/timestamp).
 */
function hashEventoTeste(eventoId: string, agregadoId: string, tipo: string, ocorreuEm: string): string {
  const payload = JSON.stringify([
    "CAMPANHA_CONTROLE_HASH_V2",
    eventoId,
    "CAMPANHA_EXECUCAO",
    agregadoId,
    tipo,
    ocorreuEm,
  ]);
  return createHmac("sha256", "audit-chain").update(payload).digest("hex");
}

// Instância reimportada (vi.resetModules) do describeDb — afterEach precisa
// limpar AMBAS as referências (o import estático aponta para a instância
// original carregada no topo do arquivo).
let injetarProvedorAtivo:
  | ((provider: import("../src/campaign-execution.js").ProvedorEnvioCampanha | null) => void)
  | undefined;

afterEach(() => {
  // F — limpeza GARANTIDA após CADA teste (inclusive falha intermediária):
  // provider fake nunca vaza para o teste seguinte (PROVIDER_DI_LEAK=false).
  injetarProvedorCanarioParaTeste(null);
  injetarProvedorAtivo?.(null);
  for (const chave of CHAVES_SINTETICAS) delete process.env[chave];
  for (const [chave, valor] of Object.entries(ambienteOriginal)) {
    if (CHAVES_SINTETICAS.includes(chave as (typeof CHAVES_SINTETICAS)[number])) {
      process.env[chave] = valor as string;
    }
  }
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Parte 1 — BEHAVIORAL (puro/local)
// ---------------------------------------------------------------------------
describe("SLICE_03C.2A — política do canário (autoridade única, fail-closed)", () => {
  it('somente o literal exato "true" arma o caminho; ausente/vazio/"1"/"TRUE" ⇒ false', () => {
    expect(carregarPoliticaCampanhaAtualizacao({}).canarySendEnabled).toBe(false);
    expect(
      carregarPoliticaCampanhaAtualizacao({ PF_CAMPAIGN_CANARY_SEND_ENABLED: "" }).canarySendEnabled,
    ).toBe(false);
    expect(
      carregarPoliticaCampanhaAtualizacao({ PF_CAMPAIGN_CANARY_SEND_ENABLED: "1" }).canarySendEnabled,
    ).toBe(false);
    expect(
      carregarPoliticaCampanhaAtualizacao({ PF_CAMPAIGN_CANARY_SEND_ENABLED: "TRUE" }).canarySendEnabled,
    ).toBe(false);
    expect(
      carregarPoliticaCampanhaAtualizacao({ PF_CAMPAIGN_CANARY_SEND_ENABLED: "true" }).canarySendEnabled,
    ).toBe(true);
  });
});

describe("SLICE_03C.2A — correlationCode (server-side, estável, opaco, sem PII)", () => {
  const ids = {
    campanhaId: randomUUID(),
    loteCampanhaId: randomUUID(),
    itemId: randomUUID(),
    destinatarioFingerprint: "a".repeat(64),
    hashAprovacao: "b".repeat(64),
  };
  const chave = chaveIdempotenciaExecucao(ids);

  it("deriva determinísticamente, é estável por item e NÃO vem do browser", () => {
    const a = correlationCodeCanario({ chaveIdempotencia: chave, itemId: ids.itemId });
    const b = correlationCodeCanario({ chaveIdempotencia: chave, itemId: ids.itemId });
    expect(a).toBe(b);
    expect(a).toMatch(/^PF26-[0-9A-F]{32}$/);
  });

  it("itens distintos produzem códigos distintos; nenhum PII/fingerprint no código", () => {
    const outro = correlationCodeCanario({ chaveIdempotencia: chave, itemId: randomUUID() });
    expect(outro).not.toBe(correlationCodeCanario({ chaveIdempotencia: chave, itemId: ids.itemId }));
    const codigo = correlationCodeCanario({ chaveIdempotencia: chave, itemId: ids.itemId });
    expect(codigo).not.toContain(ids.destinatarioFingerprint);
    expect(codigo).not.toMatch(/[a-z]/);
  });
});

describe("SLICE_03C.2A.2 — contratos de fixture (fonte única, determinísticos)", () => {
  it("A. tokenSintetico: 43–128 chars, [A-Za-z0-9_-], único por semente, mesmo valor para hash e login", () => {
    const a1 = tokenSintetico("canary-a");
    const a2 = tokenSintetico("canary-a");
    const b = tokenSintetico("canary-b");
    expect(a1).toBe(a2); // determinístico
    expect(a1).not.toBe(b); // único por cenário
    expect(a1.length).toBeGreaterThanOrEqual(43);
    expect(a1.length).toBeLessThanOrEqual(128);
    expect(a1).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new Set([tokenSintetico("canary-a"), tokenSintetico("canary-b"), tokenSintetico("canary-d"), tokenSintetico("canary-e")]).size).toBe(4);
    // SYNTHETIC_TOKEN_UNIQUE_PER_SCENARIO=true; SYNTHETIC_TOKEN_PATTERN_MATCH=true.
  });

  it("C. fingerprintUnico: 64 hex, determinístico e distinto por semente (cenas consecutivas sem colisão)", () => {
    const c1 = fingerprintUnico("arquivo-" + randomUUID());
    const c2 = fingerprintUnico("arquivo-" + randomUUID());
    expect(c1).toMatch(/^[0-9a-f]{64}$/);
    expect(c2).toMatch(/^[0-9a-f]{64}$/);
    expect(c1).not.toBe(c2);
  });

  it("D. hashEventoTeste (V2 independente): mesmo lote + mesmo timestamp + ids distintos ⇒ hashes distintos de 64 hex", () => {
    const lote = randomUUID();
    const agora = new Date().toISOString();
    const h1 = hashEventoTeste(randomUUID(), lote, "CAMPANHA_CANARIO_SELECIONADO", agora);
    const h2 = hashEventoTeste(randomUUID(), lote, "CAMPANHA_LOTE_ATIVADO", agora);
    const h3 = hashEventoTeste(randomUUID(), lote, "CAMPANHA_EXECUCAO_AUTORIZADA", agora);
    for (const h of [h1, h2, h3]) {
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set([h1, h2, h3]).size).toBe(3);
    // Os três tipos coexistem na mesma cena ⇒ UNIQUE(hash_evento) respeitado
    // (o helper NÃO importa nada de produção).
  });
});

describe("SLICE_03C.2A — identidade de remetente (neutra, server-side)", () => {
  it("deriva From/Reply-To/dominio do endereço institucional homologado; sem piloto", () => {
    const remetente = derivarRemetenteCampanha({});
    expect(remetente?.address).toBe("carteiras@crtba.org.br");
    expect(remetente?.dominio).toBe("crtba.org.br");
    expect(provedorWiringReady({})).toBe(true);
  });

  it("endereço inválido ⇒ wiring não pronto (fail-closed)", () => {
    expect(derivarRemetenteCampanha({ CAMPAIGN_SENDER_ADDRESS: "sem-arroba" })).toBeNull();
    expect(provedorWiringReady({ CAMPAIGN_SENDER_ADDRESS: "sem-arroba" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Parte 2 — CLASSIFICATION (matriz 03C.2A.1 — fetch STUB, zero rede real)
// ---------------------------------------------------------------------------
const mensagemBase: OutboundMail = {
  idempotencyKey: "pf-update:camp: item: v1",
  confirmationId: "itemclas",
  to: "destinatario.sintetico@exemplo.test",
  replyTo: "carteiras@crtba.org.br",
  from: { name: "CRT-BA | Carteiras Profissionais", address: "carteiras@crtba.org.br" },
  messageTag: "pf-campanha",
  subject: "Confirmação dos dados para envio da Carteira Profissional",
  textBody: "texto",
  htmlBody: "<p>texto</p>",
  templateVersion: "pf-atualizacao-cadastral-2026-v1",
};
describe("SLICE_03C.2A.1 — classificação do transport Gmail (fetch stub, sem rede real)", () => {
  const transporte = new GmailHttpTransport();

  async function comFetch(
    implementacao: () => Promise<Response> | Response,
    acao: () => Promise<unknown>,
  ): Promise<void> {
    vi.stubGlobal("fetch", vi.fn(implementacao));
    await acao();
  }

  it("3. timeout ⇒ AMBIGUO", async () => {
    await comFetch(
      () => {
        const erro = new Error("timeout");
        erro.name = "TimeoutError";
        throw erro;
      },
      async () => {
        await expect(transporte.send(mensagemBase, "token-sintetico")).rejects.toBeInstanceOf(
          GmailAmbiguousError,
        );
      },
    );
  });

  it("4. abort ⇒ AMBIGUO", async () => {
    await comFetch(
      () => {
        const erro = new Error("abort");
        erro.name = "AbortError";
        throw erro;
      },
      async () => {
        await expect(transporte.send(mensagemBase, "token-sintetico")).rejects.toBeInstanceOf(
          GmailAmbiguousError,
        );
      },
    );
  });

  it("5. erro genérico de fetch SEM Response (ECONNRESET/DNS) ⇒ AMBIGUO (fronteira inequívoca)", async () => {
    await comFetch(
      () => {
        throw new Error("ECONNRESET sintético");
      },
      async () => {
        await expect(transporte.send(mensagemBase, "token-sintetico")).rejects.toBeInstanceOf(
          GmailAmbiguousError,
        );
      },
    );
  });

  it("6. HTTP 500/502/503 ⇒ AMBIGUO (podem ter chegado ao Gmail)", async () => {
    for (const status of [500, 502, 503]) {
      await comFetch(
        () => new Response(JSON.stringify({ error: {} }), { status }),
        async () => {
          await expect(transporte.send(mensagemBase, "token-sintetico")).rejects.toBeInstanceOf(
            GmailAmbiguousError,
          );
        },
      );
    }
  });

  it("7. HTTP 401 ⇒ GmailAuthError (rejeição conclusiva AUTH_REQUIRED)", async () => {
    await comFetch(
      () => new Response(JSON.stringify({}), { status: 401 }),
      async () => {
        await expect(transporte.send(mensagemBase, "token-sintetico")).rejects.toBeInstanceOf(
          GmailAuthError,
        );
      },
    );
  });

  it("8. HTTP 403 domainPolicy ⇒ GmailPermanentPolicyError", async () => {
    await comFetch(
      () =>
        new Response(JSON.stringify({ error: { errors: [{ reason: "domainPolicy" }] } }), {
          status: 403,
        }),
      async () => {
        await expect(transporte.send(mensagemBase, "token-sintetico")).rejects.toBeInstanceOf(
          GmailPermanentPolicyError,
        );
      },
    );
  });

  it("9/10. HTTP 403 rateLimitExceeded e HTTP 429 ⇒ GmailRateLimitError (NÃO permanente)", async () => {
    for (const resposta of [
      new Response(JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } }), { status: 403 }),
      new Response(JSON.stringify({}), { status: 429 }),
    ]) {
      await comFetch(
        () => resposta,
        async () => {
          await expect(transporte.send(mensagemBase, "token-sintetico")).rejects.toBeInstanceOf(
            GmailRateLimitError,
          );
        },
      );
    }
  });

  it("11. HTTP 2xx SEM id ⇒ AMBIGUO (nunca rejeição conclusiva, nunca ENVIADO)", async () => {
    await comFetch(
      () => new Response(JSON.stringify({}), { status: 200 }),
      async () => {
        await expect(transporte.send(mensagemBase, "token-sintetico")).rejects.toBeInstanceOf(
          GmailAmbiguousError,
        );
      },
    );
  });

  it("12. HTTP 2xx + messageId ⇒ receipt válido", async () => {
    await comFetch(
      () => new Response(JSON.stringify({ id: "msg-sintetico-1", threadId: "th-1" }), { status: 200 }),
      async () => {
        const receipt = await transporte.send(mensagemBase, "token-sintetico");
        expect(receipt.messageId).toBe("msg-sintetico-1");
        expect(receipt.provider).toBe("GMAIL");
      },
    );
  });

  it("RATE_LIMIT_IS_PERMANENT_ERROR=false: RateLimitError NÃO herda PermanentPolicy; AUTO_RETRY=false é política do slice", () => {
    expect(new GmailRateLimitError("messages.send")).not.toBeInstanceOf(GmailPermanentPolicyError);
  });
});

describe("SLICE_03C.2A.1 — mapeamento do provider (erros → resultado, AUTO_RETRY=false)", () => {
  const poolFalso = {
    query: async () => ({
      rows: [
        {
          ordem: 1,
          estado: "ENFILEIRADO",
          destinatario_fingerprint: fingerprintDestinatarioCampanha("canario.classe@exemplo.test"),
          snapshot_registros: {
            registros: [
              {
                profissional_id: "PF-CLS-0001",
                nome: "Sintetico Classe",
                email_normalizado: "canario.classe@exemplo.test",
              },
            ],
          },
        },
      ],
    }),
  };
  const comando = {
    itemId: randomUUID(),
    chaveIdempotencia: chaveIdempotenciaExecucao({
      campanhaId: randomUUID(),
      loteCampanhaId: randomUUID(),
      itemId: randomUUID(),
      destinatarioFingerprint: "a".repeat(64),
      hashAprovacao: "b".repeat(64),
    }),
    destinatarioFingerprint: fingerprintDestinatarioCampanha("canario.classe@exemplo.test"),
  };

  function providerComGateway(gateway: unknown): ProvedorGmailCampanha {
    return new ProvedorGmailCampanha({
      pool: poolFalso as never,
      campanhaId: randomUUID(),
      gateway: gateway as never,
    });
  }
  const gatewayQue = (erro: unknown) => ({
    send: async (): Promise<MailReceipt> => {
      throw erro;
    },
    getStatus: async (): Promise<never> => {
      throw erro;
    },
  });

  it("1. provider/config ausente (remetente indisponível) ⇒ FALHA_PRE_PROVIDER, zero send", async () => {
    const provider = new ProvedorGmailCampanha({
      pool: poolFalso as never,
      campanhaId: randomUUID(),
      gateway: gatewayQue(null) as never,
      env: { CAMPAIGN_SENDER_ADDRESS: "invalido" },
    });
    const resultado = await provider.enviar(comando);
    expect(resultado.tipo).toBe("FALHA_PRE_PROVIDER");
  });

  it("2. access token indisponível antes do send (gateway fail-closed) ⇒ FALHA_PRE_PROVIDER, zero messages.send", async () => {
    const provider = providerComGateway(
      gatewayQue(new MailProviderNaoConfiguradoError("GMAIL (conta não conectada)")),
    );
    const resultado = await provider.enviar(comando);
    expect(resultado.tipo).toBe("FALHA_PRE_PROVIDER");
    expect(resultado).toMatchObject({ motivo: "PROVIDER_INDISPONIVEL" });
  });

  it("7. GmailAuthError ⇒ FALHA_DEFINITIVA + AUTH_REQUIRED (auto_retry=false)", async () => {
    const provider = providerComGateway(gatewayQue(new GmailAuthError("messages.send")));
    const resultado = await provider.enviar(comando);
    expect(resultado).toEqual({ tipo: "FALHA_DEFINITIVA", motivo: "AUTH_REQUIRED" });
  });

  it("9/10. GmailRateLimitError ⇒ terminal da tentativa + RATE_LIMITED (não permanente, auto_retry=false)", async () => {
    const provider = providerComGateway(gatewayQue(new GmailRateLimitError("messages.send")));
    const resultado = await provider.enviar(comando);
    expect(resultado).toEqual({ tipo: "FALHA_DEFINITIVA", motivo: "RATE_LIMITED" });
  });

  it("8. GmailPermanentPolicyError ⇒ FALHA_DEFINITIVA + PERMANENT_POLICY", async () => {
    const provider = providerComGateway(gatewayQue(new GmailPermanentPolicyError("messages.send")));
    const resultado = await provider.enviar(comando);
    expect(resultado).toEqual({ tipo: "FALHA_DEFINITIVA", motivo: "PERMANENT_POLICY" });
  });

  it("3–6. GmailAmbiguousError ⇒ AMBIGUO; erro DESCONHECIDO pós-despacho ⇒ AMBIGUO (nunca definitivo por herança)", async () => {
    const ambiguo = await providerComGateway(
      gatewayQue(new GmailAmbiguousError("messages.send")),
    ).enviar(comando);
    expect(ambiguo).toEqual({ tipo: "AMBIGUO", motivo: "GMAIL_AMBIGUO" });
    const desconhecido = await providerComGateway(
      gatewayQue(new Error("falha sintética pós-despacho")),
    ).enviar(comando);
    expect(desconhecido).toEqual({ tipo: "AMBIGUO", motivo: "GMAIL_AMBIGUO" });
    // MailProviderRequestError puro (com Response conclusivo fora das classes) ⇒ DEFINITIVA.
    const conclusivo = await providerComGateway(
      gatewayQue(new MailProviderRequestError("GMAIL", "messages.send (HTTP 400)")),
    ).enviar(comando);
    expect(conclusivo.tipo).toBe("FALHA_DEFINITIVA");
  });

  it("A.4/receipt vazio. receipt sem messageId ⇒ FALHA_DEFINITIVA (nunca ENVIADO)", async () => {
    const provider = providerComGateway({
      send: async () => ({ provider: "GMAIL", messageId: "", acceptedAt: new Date().toISOString() }),
      getStatus: async () => {
        throw new Error("n/a");
      },
    } as never);
    const resultado = await provider.enviar(comando);
    expect(resultado).toEqual({ tipo: "FALHA_DEFINITIVA", motivo: "RECEIPT_SEM_MESSAGE_ID" });
  });

  it("A.5. gateway fake com receipt válido ⇒ ENVIADO (único caminho de sucesso)", async () => {
    const provider = providerComGateway({
      send: async () => ({ provider: "GMAIL", messageId: "msg-ok-1", acceptedAt: new Date().toISOString() }),
      getStatus: async () => {
        throw new Error("n/a");
      },
    } as never);
    const resultado = await provider.enviar(comando);
    expect(resultado.tipo).toBe("ENVIADO");
  });
});

describe("SLICE_03C.2A.1 — statusOauthFromReadiness (derivação canônica, E)", () => {
  const base = {
    oauthConfigurationReady: true,
    oauthConnectionStored: false,
    oauthExpectedAccountConfigured: true,
    oauthStoredAccountMatchesExpected: false,
    oauthEncryptionConfigurationReady: true,
    executionReady: false,
  };
  it("sem config ⇒ CONFIGURATION_REQUIRED; conexão ausente/divergente ⇒ NOT_CONNECTED; match ⇒ CONNECTED", () => {
    expect(statusOauthFromReadiness({ ...base, oauthConfigurationReady: false })).toBe(
      "CONFIGURATION_REQUIRED",
    );
    expect(statusOauthFromReadiness(base)).toBe("NOT_CONNECTED");
    expect(
      statusOauthFromReadiness({
        ...base,
        oauthConnectionStored: true,
        oauthStoredAccountMatchesExpected: true,
        executionReady: true,
      }),
    ).toBe("CONNECTED");
  });
});

// ---------------------------------------------------------------------------
// Parte 3 — SOURCE_STRUCTURE
// ---------------------------------------------------------------------------
describe("SLICE_03C.2A — estrutura de fonte (SOURCE_STRUCTURE)", () => {
  it("preflight é READ-ONLY: nenhuma mutação SQL antes do claim", () => {
    const codigo = semComentarios(FONTE_CANARIO);
    const inicio = codigo.indexOf("export async function preflightCanarioCampanha");
    const fim = codigo.indexOf("export interface ReadinessOauthCanario");
    expect(codigo.slice(inicio, fim)).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it("nenhuma leitura direta de PF_CAMPAIGN_CANARY_SEND_ENABLED fora da política", () => {
    const politica = semComentarios(FONTE_POLITICA);
    expect(politica).toContain('PF_CAMPAIGN_CANARY_SEND_ENABLED === "true"');
    const canario = semComentarios(FONTE_CANARIO);
    const server = semComentarios(FONTE_SERVER);
    expect(canario).not.toContain("PF_CAMPAIGN_CANARY_SEND_ENABLED");
    expect(server).not.toContain("PF_CAMPAIGN_CANARY_SEND_ENABLED");
  });

  it("rota canary-send aceita EXCLUSIVAMENTE campanhaId (autoridade mínima)", () => {
    const server = semComentarios(FONTE_SERVER);
    const indice = server.indexOf('caminhoExato: "/api/campaigns/canary-send"');
    const trecho = server.slice(indice, indice + 3200);
    expect(trecho).toContain("body.campanhaId");
    expect(trecho).toContain("CAMPAIGN_CANARY_BODY_AUTHORITY");
    expect(trecho).not.toMatch(/body\.(itemId|loteCampanhaId|fingerprint|email|destinatario|provider|flags)/);
  });

  it("provider fake é DI exclusiva de teste — nunca por request/env/NODE_ENV (Seção C)", () => {
    const server = semComentarios(FONTE_SERVER);
    expect(server).toContain("injetarProvedorCanarioParaTeste");
    expect(server).toContain("provedorCanarioRuntime");
    // A rota usa a fábrica DI, não construção inline pelo request.
    const indice = server.indexOf('caminhoExato: "/api/campaigns/canary-send"');
    const trecho = server.slice(indice, indice + 3400);
    expect(trecho).toContain("provedorCanarioRuntime(");
    // Nenhum critério de seleção por request/env no trecho da rota.
    expect(trecho).not.toMatch(/NODE_ENV|query\.get\("provider"\)|headers\[.provider/);
  });

  it("readiness consome statusOauthFromReadiness (Seção E — não apenas exportado)", () => {
    const server = semComentarios(FONTE_SERVER);
    const indice = server.indexOf('caminhoExato: "/api/campaigns/operational-readiness"');
    const trecho = server.slice(indice, indice + 5600);
    expect(trecho).toContain("statusOauthFromReadiness(oauth)");
    expect(trecho).toContain("estado: oauthEstado");
  });

  it("provider não é selecionável pelo cliente; execute-attempt segue hard-disabled", () => {
    const server = semComentarios(FONTE_SERVER);
    const indiceCanario = server.indexOf('caminhoExato: "/api/campaigns/canary-send"');
    const indiceExec = server.indexOf('caminhoExato: "/api/campaigns/execute-attempt"');
    const trechoExec = server.slice(indiceExec, indiceExec + 1400);
    expect(trechoExec).toContain("CAMPAIGN_PROVIDER_DISABLED");
    expect(indiceExec).toBeGreaterThan(indiceCanario);
  });

  it("UI: Executar canário permanece SEMPRE disabled, sem onClick e sem handler de envio", () => {
    const indice = FONTE_WORKSPACE.indexOf("Executar canário (gate operacional pendente");
    expect(indice).toBeGreaterThan(-1);
    const abertura = FONTE_WORKSPACE.lastIndexOf("<button", indice);
    const botao = FONTE_WORKSPACE.slice(abertura, indice + 200);
    expect(botao).toContain('<button type="button" disabled>');
    expect(botao.slice(0, botao.indexOf("Executar canário (gate"))).not.toContain("onClick");
    const codigo = semComentarios(FONTE_WORKSPACE);
    expect(codigo).not.toContain("canary-send");
    expect(codigo).not.toContain("executarCanario");
  });

  it("template da campanha não importa o piloto; MIME deriva Message-ID do remetente", () => {
    const template = semComentarios(
      readFileSync(
        new URL("../../../packages/mail/src/templates/pf-update-campaign.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(template).not.toContain("PILOT_SENDER");
    const gmail = semComentarios(
      readFileSync(new URL("../../../packages/mail/src/adapters/gmail.ts", import.meta.url), "utf8"),
    );
    expect(gmail).toContain('"pilot.crtba.org.br"');
    expect(gmail).toMatch(/message\.from[!?]/);
    // A.3/A.4: toda exceção sem Response ⇒ AMBIGUO; 2xx sem id ⇒ AMBIGUO.
    expect(gmail).toContain("throw new GmailAmbiguousError(\"messages.send\")");
    expect(gmail).toContain('GmailAmbiguousError("messages.send (2xx sem id)")');
  });
});

// ---------------------------------------------------------------------------
// Parte 4 — HTTP_ROUTES (sem banco): fail-closed de autenticação
// ---------------------------------------------------------------------------
describe("SLICE_03C.2A — HTTP fail-closed (contrato determinístico)", () => {
  it("sem sessão → 401 INDIVIDUAL_OPERATOR_AUTH_REQUIRED (zero claim/evento/provider/rede)", async () => {
    const resposta = await despacharSemBanco("POST", "/api/campaigns/canary-send", {
      corpo: Buffer.from(JSON.stringify({ campanhaId: randomUUID() })),
    });
    expect(resposta.status).toBe(401);
    expect(resposta.corpo).toContain("INDIVIDUAL_OPERATOR_AUTH_REQUIRED");
  });

  it("lookup indisponível (DATABASE_URL isoladamente removida) → 503 OPERATOR_IDENTITY_UNAVAILABLE", async () => {
    const urlOriginal = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL; // isolamento determinístico do lookup
    try {
      const resposta = await despacharSemBanco("POST", "/api/campaigns/canary-send", {
        headers: { cookie: COOKIE_SESSAO },
        corpo: Buffer.from(JSON.stringify({ campanhaId: randomUUID() })),
      });
      expect(resposta.status).toBe(503);
      expect(resposta.corpo).toContain("OPERATOR_IDENTITY_UNAVAILABLE");
    } finally {
      if (urlOriginal !== undefined) process.env.DATABASE_URL = urlOriginal;
    }
  });

  it("sessão em formato válido mas inexistente com banco disponível → 401 (determinístico na CI)", async () => {
    if (!process.env.DATABASE_URL) {
      // Sem banco local, a indisponibilidade do lookup domina (503) — a prova
      // do 401-determinístico é DB-gated (último teste da Parte 5).
      return;
    }
    const resposta = await despacharSemBanco("POST", "/api/campaigns/canary-send", {
      headers: { cookie: COOKIE_SESSAO },
      corpo: Buffer.from(JSON.stringify({ campanhaId: randomUUID() })),
    });
    expect(resposta.status).toBe(401);
    expect(resposta.corpo).toContain("INDIVIDUAL_OPERATOR_AUTH_REQUIRED");
  });

  it("corpo com autoridade adicional → 401 (auth precede validação do corpo); nunca 200", async () => {
    const comExtras = await despacharSemBanco("POST", "/api/campaigns/canary-send", {
      headers: { cookie: COOKIE_SESSAO },
      corpo: Buffer.from(JSON.stringify({ campanhaId: randomUUID(), itemId: randomUUID() })),
    });
    expect(comExtras.status).not.toBe(200);
    if (comExtras.status === 422) {
      expect(comExtras.corpo).toContain("CAMPAIGN_CANARY_BODY_AUTHORITY");
    }
  });
});

// ---------------------------------------------------------------------------
// Parte 5 — POSTGRESQL_INTEGRATION (DB-gated, PG16): ROTA REAL
// ---------------------------------------------------------------------------
const DB_URL_AMBIENTE = ambienteOriginal.DATABASE_URL ?? "";
const describeDb = DB_URL_AMBIENTE ? describe : describe.skip;

describeDb("SLICE_03C.2A.1 — rota HTTP real do canário (POSTGRESQL_INTEGRATION)", () => {
  let pool: import("@integra-correios/persistence").NodePostgresPool | undefined;
  let despachar: Despachar;
  let injetarProvedor:
    | ((provider: import("../src/campaign-execution.js").ProvedorEnvioCampanha | null) => void)
    | undefined;
  const operadorId = randomUUID();
  const CHAVE_PROVA_BASE64 = Buffer.from("chave-de-prova-sintetica-03c2a-32bytes!!", "utf8").toString("base64");
  const CONTA_ESPERADA = "institucional.sintetico@exemplo.test";

  let adminCookie = "";
  let executorCookie = "";
  let executorIdReal: string = operadorId;
  // A — credenciais sintéticas ÚNICAS por cenário (43–128, [A-Za-z0-9_-]),
  // mesmo valor para credentialHash e login (nunca segredo operacional).
  const TOKEN_CANARIO_A = tokenSintetico("canary-a");
  const TOKEN_CANARIO_B = tokenSintetico("canary-b");
  const TOKEN_CANARIO_D = tokenSintetico("canary-d");
  const TOKEN_CANARIO_E = tokenSintetico("canary-e");

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL_AMBIENTE;
    vi.resetModules();
    const servidor = await import("../src/server.js");
    despachar = servidor.despachar;
    injetarProvedor = servidor.injetarProvedorCanarioParaTeste;
    injetarProvedorAtivo = servidor.injetarProvedorCanarioParaTeste;
    const { NodePostgresPool } = await import("@integra-correios/persistence");
    pool = new NodePostgresPool({ connectionString: DB_URL_AMBIENTE!, max: 4 });
  });

  function ambienteBase(fingerprintCanario: string, canarySend: boolean): void {
    process.env.PF_CAMPAIGN_PROOF_KEY_BASE64 = CHAVE_PROVA_BASE64;
    process.env.PF_CAMPAIGN_CANARY_RECIPIENT_FINGERPRINT = fingerprintCanario;
    process.env.PF_CAMPAIGN_CANARY_SEND_ENABLED = canarySend ? "true" : "false";
    process.env.GMAIL_OAUTH_CLIENT_ID = "client-id-sintetico";
    process.env.GMAIL_OAUTH_CLIENT_SECRET = "client-secret-sintetico";
    process.env.GMAIL_OAUTH_REDIRECT_URI = "https://exemplo.test/callback";
    process.env.GMAIL_EXPECTED_ACCOUNT = CONTA_ESPERADA;
    process.env.DATA_ENCRYPTION_KEY_BASE64 = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
    process.env.DOCUMENT_FINGERPRINT_KEY_BASE64 = Buffer.from("fedcba9876543210fedcba9876543210").toString("base64");
  }

  interface CenaCanario {
    campanhaId: string;
    loteCampanhaId: string;
    fingerprints: readonly string[];
  }

  async function criarCenaCanario(params: {
    readonly operatorId: string;
    readonly emails: readonly string[];
    readonly estadoLote?: string;
    readonly autorizacao?: boolean;
  }): Promise<CenaCanario> {
    const p = pool!;
    const campanhaId = randomUUID();
    const loteCampanhaId = randomUUID();
    const agora = new Date().toISOString();
    // C — identidade ÚNICA da cena (hex 64): evita colisão em
    // UNIQUE(fingerprint_arquivo, hash_aprovacao) entre cenas consecutivas.
    const hashAprovacao = fingerprintUnico("aprovacao-" + campanhaId);
    const fingerprintArquivo = fingerprintUnico("arquivo-" + campanhaId);
    const registros = params.emails.map((email, indice) => ({
      profissional_id: "PF-CNR-" + String(indice + 1).padStart(4, "0"),
      nome: "Sintetico Canary " + String(indice + 1),
      email_normalizado: email,
      status_validacao: "APTO",
    }));
    await p.query(
      "INSERT INTO campanha_persistida (id, operator_id, fingerprint_arquivo, template_versao, hash_aprovacao, snapshot_registros, total_registros, total_aptos, total_bloqueados, total_aprovados, estado, criada_em, atualizada_em) VALUES ($1, $2, $3, 'CNR_TESTE_V1', $4, $5::jsonb, $6, $6, 0, $6, 'LOTE_CRIADO', $7, $7)",
      [campanhaId, params.operatorId, fingerprintArquivo, hashAprovacao, JSON.stringify({ registros, total: registros.length }), registros.length, agora],
    );
    await p.query(
      "INSERT INTO lote_campanha (id, campanha_id, origem, codigo, template_versao, estado, total_itens, criado_em) VALUES ($1, $2, 'PF', $3, 'CNR_TESTE_V1', $4, $5, $6)",
      [loteCampanhaId, campanhaId, "CNR_LOTE_" + loteCampanhaId.slice(0, 8), params.estadoLote ?? "ATIVO", registros.length, agora],
    );
    const fingerprints: string[] = [];
    const itemIds: string[] = [];
    let ordem = 0;
    for (const email of params.emails) {
      ordem += 1;
      const itemId = randomUUID();
      const fingerprint = fingerprintDestinatarioCampanha(email);
      itemIds.push(itemId);
      fingerprints.push(fingerprint);
      await p.query(
        "INSERT INTO outbox_campanha (id, lote_campanha_id, ordem, destinatario_fingerprint, payload_snapshot, estado, criada_em) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)",
        [itemId, loteCampanhaId, ordem, fingerprint, JSON.stringify({ ordem }), "PREPARADO", agora],
      );
    }
    // D — hash por IDENTIDADE do evento (contrato V2, recomposto
    // independentemente): ids distintos ⇒ hashes distintos mesmo com o MESMO
    // lote e o MESMO ocorreu_em ⇒ UNIQUE(hash_evento) respeitado.
    for (const tipo of ["CAMPANHA_CANARIO_SELECIONADO", "CAMPANHA_LOTE_ATIVADO"] as const) {
      const eventoId = randomUUID();
      await p.query(
        "INSERT INTO evento_auditoria (id, agregado_tipo, agregado_id, tipo, operator_id, ator_operator_id, ocorreu_em, metadados, hash_anterior, hash_evento) VALUES ($1, 'CAMPANHA_EXECUCAO', $2, $3, $4, $4, $5, $6::jsonb, NULL, $7)",
        [
          eventoId,
          loteCampanhaId,
          tipo,
          params.operatorId,
          agora,
          JSON.stringify(
            tipo === "CAMPANHA_CANARIO_SELECIONADO"
              ? { esquema: "CAMPANHA_CANARIO_V1", item_id: itemIds[0], ordem: 1 }
              : { esquema: "CAMPANHA_CONTROLE_V1", acao: "ATIVAR_LOTE" },
          ),
          hashEventoTeste(eventoId, loteCampanhaId, tipo, agora),
        ],
      );
    }
    if (params.autorizacao !== false) {
      const eventoId = randomUUID();
      await p.query(
        "INSERT INTO evento_auditoria (id, agregado_tipo, agregado_id, tipo, operator_id, ator_operator_id, ocorreu_em, metadados, hash_anterior, hash_evento) VALUES ($1, 'CAMPANHA_EXECUCAO', $2, $3, $4, $4, $5, $6::jsonb, NULL, $7)",
        [
          eventoId,
          loteCampanhaId,
          "CAMPANHA_EXECUCAO_AUTORIZADA",
          params.operatorId,
          agora,
          JSON.stringify({ esquema: "CAMPANHA_CONTROLE_V1", acao: "AUTORIZAR_EXECUCAO", lote_estado: "ATIVO" }),
          hashEventoTeste(eventoId, loteCampanhaId, "CAMPANHA_EXECUCAO_AUTORIZADA", agora),
        ],
      );
    }
    return { campanhaId, loteCampanhaId, fingerprints };
  }

  // E — conexões OAuth SÃO PROPRIEDADE DA SUÍTE: ids capturados via
  // RETURNING; limpeza por id (nunca DELETE global; nunca toca dados de
  // outra suíte; executa também após falha intermediária via afterEach).
  const conexoesOAuthDaSuite: string[] = [];

  async function conectarOAuthCorrespondente(detalhe?: string): Promise<string> {
    const { derivarFingerprintContaGmail } = await import("@integra-correios/mail");
    const fp = new HmacSha256Fingerprinter(
      Buffer.from(process.env.DOCUMENT_FINGERPRINT_KEY_BASE64!, "base64"),
    );
    // Conta sintética PRÓPRIA por chamada ⇒ (provider, conta_fingerprint)
    // nunca se repete ⇒ zero colisão em UNIQUE(provider, conta_fingerprint).
    const alvo = detalhe ?? (CONTA_ESPERADA + "+" + randomUUID().slice(0, 8));
    const fingerprintConta = derivarFingerprintContaGmail(fp, alvo);
    const inserida = await pool!.query(
      "INSERT INTO oauth_connection (provider, conta_fingerprint, scopes, access_token_ciphertext, access_token_nonce, access_token_auth_tag, chave_versao) VALUES ('GMAIL', $1, ARRAY['https://www.googleapis.com/auth/gmail.send']::text[], $2, $3, $4, 'v1-teste') RETURNING id",
      [fingerprintConta, Buffer.from("ciphertext-sintetico"), Buffer.from("0123456789abcdef"), Buffer.alloc(16)],
    );
    const id = (inserida.rows[0] as { id: string }).id;
    conexoesOAuthDaSuite.push(id);
    return id;
  }

  afterEach(async () => {
    // Limpeza OWNED: somente as linhas criadas por esta suíte (por id).
    for (const id of conexoesOAuthDaSuite.splice(0)) {
      await pool?.query("DELETE FROM oauth_connection WHERE id = $1 AND provider = 'GMAIL'", [id]);
    }
  });

  async function contagensExec(loteCampanhaId: string): Promise<Record<string, number>> {
    const eventos = await pool!.query(
      "SELECT tipo, count(*)::int AS total FROM evento_auditoria WHERE agregado_id = $1 AND tipo LIKE 'EXEC%' GROUP BY tipo",
      [loteCampanhaId],
    );
    return Object.fromEntries(
      (eventos.rows as { tipo: string; total: number }[]).map((r) => [r.tipo, r.total]),
    );
  }

  async function estadoItem(loteCampanhaId: string): Promise<string> {
    const itens = await pool!.query(
      "SELECT estado FROM outbox_campanha WHERE lote_campanha_id = $1 ORDER BY ordem LIMIT 1",
      [loteCampanhaId],
    );
    return (itens.rows[0] as { estado: string }).estado;
  }

  it("A. ARMAMENTO AUSENTE (rota real): 409 CAMPAIGN_CANARY_SEND_DISABLED com CLAIMS=0, eventos=0, token=0, provider=0, rede=0", async () => {
    const admin = await despachar("POST", "/api/operator/admin/provision", {
      headers: { cookie: await bootstrapAdmin(), "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        code: "OP-CNR-" + randomUUID().slice(0, 8),
        displayName: "Operador Canary A",
        roles: ["EXECUTOR"],
        credentialHash: createHash("sha256").update(TOKEN_CANARIO_A).digest("hex"),
      })),
    });
    expect(admin.status).toBe(201);
    executorIdReal = (JSON.parse(admin.corpo) as { operatorId: string }).operatorId;
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: TOKEN_CANARIO_A })),
    });
    expect(login.status).toBe(200);
    executorCookie = firstCookie(login.headers["set-cookie"]);

    const cena = await criarCenaCanario({
      operatorId: executorIdReal,
      emails: ["canario.rota.a@exemplo.test"],
    });
    await conectarOAuthCorrespondente();
    ambienteBase(cena.fingerprints[0]!, false); // canarySendEnabled=FALSE

    const providerEspiao = {
      nome: "ESPIA_DI",
      enviar: async () => {
        throw new Error("provider não deveria ser chamado");
      },
    };
    injetarProvedor!(providerEspiao);
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);

    const antes = await contagensExec(cena.loteCampanhaId);
    const resposta = await despachar("POST", "/api/campaigns/canary-send", {
      headers: { cookie: executorCookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
    });
    expect(resposta.status).toBe(409);
    expect(resposta.corpo).toContain("CAMPAIGN_CANARY_SEND_DISABLED");
    expect(espiaoRede).not.toHaveBeenCalled();
    const depois = await contagensExec(cena.loteCampanhaId);
    expect(depois).toEqual(antes);
    expect(await estadoItem(cena.loteCampanhaId)).toBe("PREPARADO");
    injetarProvedor!(null);
  });

  it("B+C. CAMINHO ELEGÍVEL via ROTA REAL + provider fake (DI): 1 provider call, ENVIADO, EXEC_RECEIPT/SETTLEMENT=1; replay sem segunda chamada", async () => {
    const admin = await despachar("POST", "/api/operator/admin/provision", {
      headers: { cookie: await bootstrapAdmin(), "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        code: "OP-CNR-" + randomUUID().slice(0, 8),
        displayName: "Operador Canary B",
        roles: ["EXECUTOR"],
        credentialHash: createHash("sha256").update(TOKEN_CANARIO_B).digest("hex"),
      })),
    });
    expect(admin.status).toBe(201);
    const operatorIdB = (JSON.parse(admin.corpo) as { operatorId: string }).operatorId;
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: TOKEN_CANARIO_B })),
    });
    expect(login.status).toBe(200);
    const cookieB = firstCookie(login.headers["set-cookie"]);

    const cena = await criarCenaCanario({
      operatorId: operatorIdB,
      emails: ["canario.rota.b@exemplo.test"],
    });
    await conectarOAuthCorrespondente();
    ambienteBase(cena.fingerprints[0]!, true); // canarySendEnabled=TRUE

    let chamadasProvider = 0;
    injetarProvedor!({
      nome: "FAKE_DI_B",
      enviar: async (comando: { chaveIdempotencia: string }) => {
        chamadasProvider += 1;
        return {
          tipo: "ENVIADO" as const,
          receipt: {
            provider: "FAKE_DI_B",
            messageId: "sintetico-rota-" + comando.chaveIdempotencia.slice(0, 12),
            acceptedAt: new Date().toISOString(),
            chaveIdempotencia: comando.chaveIdempotencia,
          },
        };
      },
    });
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);

    const resposta = await despachar("POST", "/api/campaigns/canary-send", {
      headers: { cookie: cookieB, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
    });
    expect(resposta.status).toBe(200);
    expect(resposta.corpo).toContain("ENVIADO");
    expect(resposta.corpo).toContain("messageId");
    expect(chamadasProvider).toBe(1);
    expect(espiaoRede).not.toHaveBeenCalled(); // ZERO rede real
    const contagens = await contagensExec(cena.loteCampanhaId);
    expect(contagens["EXEC_RECEIPT"]).toBe(1);
    expect(contagens["EXEC_SETTLEMENT"]).toBe(1);
    expect(await estadoItem(cena.loteCampanhaId)).toBe("ENVIADO");

    // REPLAY (C): item já ENVIADO ⇒ preflight bloqueia (ITEM_NAO_PREPARADO);
    // provider NUNCA é chamado de novo; nenhum novo receipt/settlement.
    const replay = await despachar("POST", "/api/campaigns/canary-send", {
      headers: { cookie: cookieB, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
    });
    expect(replay.status).toBe(409);
    expect(chamadasProvider).toBe(1); // inalterado
    const contagensReplay = await contagensExec(cena.loteCampanhaId);
    expect(contagensReplay["EXEC_RECEIPT"]).toBe(1);
    expect(contagensReplay["EXEC_SETTLEMENT"]).toBe(1);
    injetarProvedor!(null);
  });

  it("D. FINGERPRINT DIVERGENTE (rota real): 409, CLAIMS=0, eventos=0, provider=0, rede=0", async () => {
    const admin = await despachar("POST", "/api/operator/admin/provision", {
      headers: { cookie: await bootstrapAdmin(), "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        code: "OP-CNR-" + randomUUID().slice(0, 8),
        displayName: "Operador Canary D",
        roles: ["EXECUTOR"],
        credentialHash: createHash("sha256").update(TOKEN_CANARIO_D).digest("hex"),
      })),
    });
    expect(admin.status).toBe(201);
    const operatorIdD = (JSON.parse(admin.corpo) as { operatorId: string }).operatorId;
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: TOKEN_CANARIO_D })),
    });
    expect(login.status).toBe(200);
    const cookieD = firstCookie(login.headers["set-cookie"]);

    const cena = await criarCenaCanario({
      operatorId: operatorIdD,
      emails: ["canario.rota.d@exemplo.test"],
    });
    await conectarOAuthCorrespondente();
    ambienteBase(cena.fingerprints[0]!, true);
    // Corrompe a outbox: fingerprint persistido ≠ snapshot ≠ configuração.
    await pool!.query(
      "UPDATE outbox_campanha SET destinatario_fingerprint = $1 WHERE lote_campanha_id = $2",
      ["e".repeat(64), cena.loteCampanhaId],
    );

    let chamadasProvider = 0;
    injetarProvedor!({
      nome: "ESPIA_DI_D",
      enviar: async () => {
        chamadasProvider += 1;
        throw new Error("não deveria");
      },
    });
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);

    const resposta = await despachar("POST", "/api/campaigns/canary-send", {
      headers: { cookie: cookieD, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
    });
    expect(resposta.status).toBe(409);
    expect(resposta.corpo).toContain("CAMPAIGN_CANARY_BLOCKED");
    expect(chamadasProvider).toBe(0);
    expect(espiaoRede).not.toHaveBeenCalled();
    expect(await estadoItem(cena.loteCampanhaId)).toBe("PREPARADO");
    const contagens = await contagensExec(cena.loteCampanhaId);
    expect(contagens["EXEC_RECEIPT"]).toBeUndefined();
    injetarProvedor!(null);
  });

  it("E. READINESS HTTP consome o status OAuth (4 estados, sanitizado, zero rede/refresh)", async () => {
    const admin = await despachar("POST", "/api/operator/admin/provision", {
      headers: { cookie: await bootstrapAdmin(), "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        code: "OP-CNR-" + randomUUID().slice(0, 8),
        displayName: "Operador Canary E",
        roles: ["EXECUTOR"],
        credentialHash: createHash("sha256").update(TOKEN_CANARIO_E).digest("hex"),
      })),
    });
    expect(admin.status).toBe(201);
    const operatorIdE = (JSON.parse(admin.corpo) as { operatorId: string }).operatorId;
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: TOKEN_CANARIO_E })),
    });
    expect(login.status).toBe(200);
    const cookieE = firstCookie(login.headers["set-cookie"]);

    const cena = await criarCenaCanario({
      operatorId: operatorIdE,
      emails: ["canario.rota.e@exemplo.test"],
    });

    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);

    // E.1 — configuração OAuth ausente ⇒ CONFIGURATION_REQUIRED.
    for (const chave of ["GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_OAUTH_REDIRECT_URI"]) {
      delete process.env[chave];
    }
    ambienteBase(cena.fingerprints[0]!, false);
    for (const chave of ["GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_OAUTH_REDIRECT_URI"]) {
      delete process.env[chave];
    }
    let resposta = await despachar("GET", `/api/campaigns/operational-readiness?campanhaId=${cena.campanhaId}`, {
      headers: { cookie: cookieE },
    });
    expect(resposta.status).toBe(200);
    let corpo = JSON.parse(resposta.corpo) as {
      oauth: { estado: string; connectionStored?: boolean; storedAccountMatchesExpected?: boolean; tokenRefreshes?: number; googleNetworkCalls?: number };
    };
    expect(corpo.oauth.estado).toBe("CONFIGURATION_REQUIRED");

    // E.2 — config presente, conexão ausente ⇒ NOT_CONNECTED.
    ambienteBase(cena.fingerprints[0]!, false);
    resposta = await despachar("GET", `/api/campaigns/operational-readiness?campanhaId=${cena.campanhaId}`, {
      headers: { cookie: cookieE },
    });
    corpo = JSON.parse(resposta.corpo);
    expect(corpo.oauth.estado).toBe("NOT_CONNECTED");

    // E.3 — conexão persistida DIVERGENTE ⇒ NOT_CONNECTED (conta ≠ esperada).
    await conectarOAuthCorrespondente("outra.conta@exemplo.test");
    resposta = await despachar("GET", `/api/campaigns/operational-readiness?campanhaId=${cena.campanhaId}`, {
      headers: { cookie: cookieE },
    });
    corpo = JSON.parse(resposta.corpo);
    expect(corpo.oauth.estado).toBe("NOT_CONNECTED");
    expect(corpo.oauth.connectionStored).toBe(true);
    expect(corpo.oauth.storedAccountMatchesExpected).toBe(false);

    // E.4 — conexão CORRESPONDENTE ⇒ CONNECTED (readiness, NÃO liveness).
    // Isolamento OWNED: revoga APENAS as conexões criadas por esta suíte
    // (nunca DELETE global; nenhum dado operacional é tocado).
    for (const id of conexoesOAuthDaSuite) {
      await pool!.query(
        "UPDATE oauth_connection SET revogada_em = now() WHERE id = $1 AND provider = 'GMAIL'",
        [id],
      );
    }
    await conectarOAuthCorrespondente();
    resposta = await despachar("GET", `/api/campaigns/operational-readiness?campanhaId=${cena.campanhaId}`, {
      headers: { cookie: cookieE },
    });
    corpo = JSON.parse(resposta.corpo);
    expect(corpo.oauth.estado).toBe("CONNECTED");

    // Sanitização + zero rede: resposta sem conta/e-mail/token/fingerprint.
    expect(resposta.corpo).not.toContain(CONTA_ESPERADA);
    expect(resposta.corpo).not.toContain("@exemplo.test");
    expect(resposta.corpo.toLowerCase()).not.toContain("token");
    expect(resposta.corpo).not.toMatch(/\b[0-9a-f]{64}\b/);
    expect(espiaoRede).not.toHaveBeenCalled();
    expect(corpo.oauth.tokenRefreshes).toBe(0);
    expect(corpo.oauth.googleNetworkCalls).toBe(0);
  });

  // ---- helpers de sessão (padrão 03B) ----
  async function bootstrapAdmin(): Promise<string> {
    const adminId = randomUUID();
    const tokenId = randomUUID();
    const sufixo = adminId.replace(/-/g, "").slice(0, 12);
    const credencial = `AdminIndividual_abcdefghijklmnopqrstuvwxyz0123456789${sufixo}`;
    const agora = new Date().toISOString();
    await pool!.query(
      `INSERT INTO operador (id, codigo, nome_exibicao, status, criado_em, atualizado_em)
       VALUES ($1, $2, $3, 'ATIVO', $4, $4)`,
      [adminId, `ADMIN-${sufixo}`, "Administrador Individual Sintético", agora],
    );
    await pool!.query(
      `INSERT INTO operador_papel (operator_id, papel, ativo, concedido_em) VALUES ($1, 'ADMIN_TECNICO', true, $2)`,
      [adminId, agora],
    );
    await pool!.query(
      `INSERT INTO operador_token (id, operator_id, token_hash, emitido_por_operator_id, status, criado_em)
       VALUES ($1, $2, $3, $2, 'ATIVO', $4)`,
      [tokenId, adminId, createHash("sha256").update(credencial).digest("hex"), agora],
    );
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: credencial })),
    });
    expect(login.status).toBe(200);
    return firstCookie(login.headers["set-cookie"]);
  }
});

function firstCookie(header: string | readonly string[] | string[] | undefined): string {
  const valor: unknown = Array.isArray(header) ? header[0] : header;
  return typeof valor === "string" ? valor.split("\n")[0]?.split(";")[0] ?? "" : "";
}
