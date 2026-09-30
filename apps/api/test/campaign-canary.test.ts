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
import {
  ACAO_AUTORIZADA_EXECUCAO,
  fingerprintDestinatarioCampanha,
} from "../src/campaign-control.js";
import { avaliarReadinessOauthCanario } from "../src/campaign-canary.js";
import { criarCampanhaGmailRuntime } from "../src/campaign-gmail-runtime.js";
import {
  derivarFingerprintContaGmail,
  GmailAmbiguousError,
  GmailAuthError,
  GmailHttpTransport,
  GmailMailGateway,
  GmailPermanentPolicyError,
  GmailRateLimitError,
  MailProviderNaoConfiguradoError,
  MailProviderRequestError,
  type MailReceipt,
  type OutboundMail,
} from "@integra-correios/mail";
import {
  Aes256GcmSecretBox,
  HmacSha256Fingerprinter,
} from "@integra-correios/persistence";

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

// 03C.2A.4 — MATRIZ EXPLÍCITA DE POLÍTICA POR CENÁRIO (fonte única).
// Somente a string literal "true" habilita cada flag no loader; a matriz
// torna explícito, por cenário, quais gates sintéticos estão abertos.
const MATRIZ_POLITICA_CENARIO = {
  A: { canarySend: false, execute: true, realSend: true },
  B: { canarySend: true, execute: true, realSend: true },
  D: { canarySend: true, execute: true, realSend: true },
  E: { canarySend: false, execute: false, realSend: false },
} as const;
type MatrizGatesCenario = (typeof MATRIZ_POLITICA_CENARIO)[keyof typeof MATRIZ_POLITICA_CENARIO];
type CenarioCanario = keyof typeof MATRIZ_POLITICA_CENARIO;

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
// ---------------------------------------------------------------------------
// SLICE_03C.2A.3 — CONSTANTES SINTÉTICAS ÚNICAS (fonte única para o ambiente
// E para a fixture OAuth — sem leitura implícita de env no helper; sem segredo
// real; nonce com EXATAMENTE 12 bytes e auth tag com EXATAMENTE 16 bytes,
// conforme os CHECKs do schema oauth_connection).
// ---------------------------------------------------------------------------
const CHAVE_FINGERPRINT_FIXTURE_B64 = Buffer.from(
  "fp-fixture-key-03c2a3-32bytes!!!",
  "utf8",
).toString("base64"); // exatamente 32 bytes ao decodificar (exige HmacSha256Fingerprinter)
const OAUTH_NONCE_FIXTURE = Buffer.from("nonce1234567", "utf8"); // exatamente 12 bytes
const OAUTH_AUTH_TAG_FIXTURE = Buffer.alloc(16); // exatamente 16 bytes

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

  it("03C.2A.3. fingerprint default = conta esperada; divergente ≠; helper sem sufixo (fonte)", () => {
    const fp = new HmacSha256Fingerprinter(Buffer.from(CHAVE_FINGERPRINT_FIXTURE_B64, "base64"));
    const esperado = derivarFingerprintContaGmail(fp, "institucional.sintetico@exemplo.test");
    const divergente = derivarFingerprintContaGmail(fp, "outra.conta@exemplo.test");
    // DEFAULT_FINGERPRINT_MATCH=true — o default do helper deriva da MESMA
    // conta esperada; DIVERGENT_MISMATCH=true — conta diferente ⇒ hash ≠.
    expect(esperado).toMatch(/^[0-9a-f]{64}$/);
    expect(divergente).toMatch(/^[0-9a-f]{64}$/);
    expect(divergente).not.toBe(esperado);
    // Estrutural: o helper NÃO acrescenta sufixo à conta default (a fonte do
    // próprio teste não contém concatenação de sufixo na conta esperada).
    const fonteTeste = readFileSync(new URL("./campaign-canary.test.ts", import.meta.url), "utf8");
    // Construído dinamicamente para a asserção não conter o próprio literal.
    const sufixoProibido = "CONTA_ESPERADA" + " " + '+' + " " + '"' + "+" + '"';
    expect(fonteTeste).not.toContain(sufixoProibido);
    expect(fonteTeste).toContain("const alvo = detalhe ?? CONTA_ESPERADA;");
  });

  it("03C.2A.4. matriz de política explícita por cenário (fonte única, gates independentes)", () => {
    const fonteTeste = readFileSync(new URL("./campaign-canary.test.ts", import.meta.url), "utf8");
    // (a) Contrato da matriz por cenário (tipada, sem default implícito).
    expect(MATRIZ_POLITICA_CENARIO.A).toEqual({ canarySend: false, execute: true, realSend: true });
    expect(MATRIZ_POLITICA_CENARIO.B).toEqual({ canarySend: true, execute: true, realSend: true });
    expect(MATRIZ_POLITICA_CENARIO.D).toEqual({ canarySend: true, execute: true, realSend: true });
    expect(MATRIZ_POLITICA_CENARIO.E).toEqual({ canarySend: false, execute: false, realSend: false });
    // (b) TODAS as chamadas de rota passam a matriz explícita (5 chamadas: A,B,D,E,E).
    const chamadas = fonteTeste.match(/ambienteBase\(cena\.fingerprints\[0\]!, MATRIZ_POLITICA_CENARIO\.[A-E]\)/g) ?? [];
    expect(chamadas.length).toBe(5);
    expect(new Set(chamadas.map((c) => c.slice(-2, -1))).size).toBe(4);
    // (c) ambienteBase deriva cada gate EXPLICITAMENTE da matriz — nunca ausente.
    for (const [chave, gate] of [
      ["PF_CAMPAIGN_CANARY_SEND_ENABLED", "canarySend"],
      ["PF_CAMPAIGN_EXECUTE_ENABLED", "execute"],
      ["REAL_SEND_ENABLED", "realSend"],
    ] as const) {
      expect(fonteTeste).toContain('process.env.' + chave + ' = gates.' + gate + ' ? "true" : "false";');
    }
    // (d) Contrato do loader: SOMENTE o literal exato "true" habilita, cada
    // flag independentemente; ausência/valores diversos ⇒ fail-closed.
    for (const [chave, propriedade] of [
      ["PF_CAMPAIGN_CANARY_SEND_ENABLED", "canarySendEnabled"],
      ["PF_CAMPAIGN_EXECUTE_ENABLED", "canExecute"],
      ["REAL_SEND_ENABLED", "realSendEnabled"],
    ] as const) {
      expect(carregarPoliticaCampanhaAtualizacao({ [chave]: "true" })[propriedade]).toBe(true);
      expect(carregarPoliticaCampanhaAtualizacao({ [chave]: "1" })[propriedade]).toBe(false);
      expect(carregarPoliticaCampanhaAtualizacao({})[propriedade]).toBe(false);
    }
  });

  it("03C.2A.5. ação da prova humana é a constante canônica de produção (control plane ≠ prova)", () => {
    // Contratos DISTINTOS por desenho: "AUTORIZAR_EXECUCAO" é a ação do
    // control plane; a constante canônica de produção é a ação que a prova
    // humana autoriza e o antirreplay verifica. A fixture grava EXATAMENTE a
    // constante de produção — sem aceitar os dois valores, sem relaxar o
    // antirreplay.
    expect(ACAO_AUTORIZADA_EXECUCAO).toBe("EXECUTAR_ITEM_CAMPANHA");
  });

  it("03C.2A.3. nonce=12 bytes, authTag=16 bytes, chave de fingerprint válida (contrato do schema)", () => {
    expect(OAUTH_NONCE_FIXTURE.length).toBe(12);
    expect(OAUTH_AUTH_TAG_FIXTURE.length).toBe(16);
    const decodificada = Buffer.from(CHAVE_FINGERPRINT_FIXTURE_B64, "base64");
    expect(decodificada.length).toBe(32);
    // A MESMA constante é usada pelo ambienteBase e pela fixture OAuth —
    // FINGERPRINT_KEY_SOURCE_MATCH=true por construção (fonte única).
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
          template_versao: "pf-expedicao-carteira-2026-v2",
          hash_aprovacao: "b".repeat(64),
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

  it("2B1D-H. provider resolve pela versão CONGELADA no lote: versão não registrada ⇒ FALHA_PRE_PROVIDER sanitizada, zero gateway", async () => {
    let chamadasGateway = 0;
    const gatewayEspiao = {
      send: async () => {
        chamadasGateway += 1;
        throw new Error("gateway não deveria ser invocado com versão inválida");
      },
      getStatus: async () => {
        throw new Error("n/a");
      },
    } as never;
    // Linha com versão DESCONHECIDA: falha sanitizada ANTES do gateway.
    const providerComVersao = new ProvedorGmailCampanha({
      pool: {
        query: async () => ({
          rows: [
            {
              ordem: 1,
              estado: "ENFILEIRADO",
              template_versao: "versao-sintetica-nao-registrada-2B1D",
              hash_aprovacao: "",
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
      } as never,
      campanhaId: randomUUID(),
      gateway: gatewayEspiao,
      env: { CAMPAIGN_SENDER_ADDRESS: "carteiras@crtba.org.br" },
    });
    const resultado = await providerComVersao.enviar(comando);
    expect(resultado).toEqual({
      tipo: "FALHA_PRE_PROVIDER",
      motivo: "TEMPLATE_VERSAO_NAO_REGISTRADA",
    });
    expect(chamadasGateway).toBe(0);
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

  it("lookup indisponível → 503 OPERATOR_IDENTITY_UNAVAILABLE (IMPORTAÇÃO ISOLADA; singleton intocado)", async () => {
    // SERVER_SINGLETON_CROSS_TEST_LEAK=false: a instância estática
    // (despacharSemBanco) NUNCA é usada sem DATABASE_URL. A prova do 503 usa
    // uma importação isolada (vi.resetModules + import dinâmico) que morre no
    // fim do teste — o cache recursos.pool da instância compartilhada fica
    // intocado para o teste seguinte.
    const urlOriginal = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    let despacharIsolado: Despachar | undefined;
    try {
      vi.resetModules();
      const servidorIsolado = await import("../src/server.js");
      despacharIsolado = servidorIsolado.despachar as Despachar;
      const resposta = await despacharIsolado("POST", "/api/campaigns/canary-send", {
        headers: { cookie: COOKIE_SESSAO },
        corpo: Buffer.from(JSON.stringify({ campanhaId: randomUUID() })),
      });
      expect(resposta.status).toBe(503);
      expect(resposta.corpo).toContain("OPERATOR_IDENTITY_UNAVAILABLE");
    } finally {
      if (urlOriginal !== undefined) process.env.DATABASE_URL = urlOriginal;
      vi.resetModules(); // descarta a instância contaminada (não reutilizada)
    }
  });

  it("sessão em formato válido mas inexistente com banco disponível → 401 (instância NÃO contaminada)", async () => {
    if (!process.env.DATABASE_URL) {
      // Sem banco local, a prova determinística do 401 é DB-gated (Parte 5).
      return;
    }
    // A instância estática nunca foi usada sem DATABASE_URL (o 503 usou
    // importação isolada) — nenhum pool envenenado aqui.
    const resposta = await despacharSemBanco("POST", "/api/campaigns/canary-send", {
      headers: { cookie: COOKIE_SESSAO },
      corpo: Buffer.from(JSON.stringify({ campanhaId: randomUUID() })),
    });
    expect(resposta.status).toBe(401);
    expect(resposta.corpo).toContain("INDIVIDUAL_OPERATOR_AUTH_REQUIRED");
  });

  it("GF3 F1 — canary-send exige EXECUTOR: 403 OPERATOR_ROLE_FORBIDDEN ANTES de política/preflight (zero claim/token/provider/rede)", async () => {
    // Sessão com formato válido (cookie __Host-): a resolução de identidade
    // exige banco; sem DATABASE_URL a rota responde 401/503 — a prova
    // determinística dos 403 por papel é DB-gated (Parte 5). Aqui provamos
    // APENAS que a rota NUNCA responde 409 CAMPAIGN_CANARY_SEND_DISABLED sem
    // sessão EXECUTOR (a guarda de papel precede a checagem de política).
    const resposta = await despacharSemBanco("POST", "/api/campaigns/canary-send", {
      headers: { cookie: COOKIE_SESSAO },
      corpo: Buffer.from(JSON.stringify({ campanhaId: randomUUID() })),
    });
    expect(resposta.status).not.toBe(409);
    expect(resposta.corpo).not.toContain("CAMPAIGN_CANARY_SEND_DISABLED");
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

// ---------------------------------------------------------------------------
// 03C.2A.4 — contrato de sanitização ESTRUTURAL da resposta de readiness.
// Allowlist das chaves públicas de corpo.oauth (tokenRefreshes é telemetria
// numérica legítima e PERMITIDA; o substring-match bruto "token", que gerava
// falso-positivo, foi removido SEM diluir o contrato).
// ---------------------------------------------------------------------------
const CHAVES_OAUTH_PUBLICAS = [
  "configurationReady",
  "connectionStored",
  "expectedAccountConfigured",
  "storedAccountMatchesExpected",
  "encryptionConfigurationReady",
  "executionReady",
  "estado",
  "tokenRefreshes",
  "googleNetworkCalls",
] as const;

function varrerCamposProibidos(json: string, proibidos: readonly string[]): string[] {
  const violacoes: string[] = [];
  const visitas = (no: unknown, caminho: string): void => {
    if (Array.isArray(no)) {
      no.forEach((item, indice) => visitas(item, caminho + "[" + String(indice) + "]"));
      return;
    }
    if (no !== null && typeof no === "object") {
      for (const [chave, valor] of Object.entries(no as Record<string, unknown>)) {
        const caminhoFilho = caminho + "." + chave;
        if (proibidos.includes(chave.toLowerCase())) violacoes.push(caminhoFilho);
        visitas(valor, caminhoFilho);
      }
      return;
    }
    if (typeof no === "string") {
      const folha = no.toLowerCase();
      for (const proibido of proibidos) {
        if (folha.includes(proibido)) violacoes.push(caminho + ' ~ "' + proibido + '"');
      }
    }
  };
  visitas(JSON.parse(json), "$");
  return violacoes;
}

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

  // GF-3 CORRECTIVE-01 (F1) — matriz de autoridade do canário: somente
  // EXECUTOR passa da guarda de papel. Qualquer outro papel ⇒ 403 estável
  // ANTES de preflight/claim/token/provider (zero claim, zero rede).
  it("2B1A-F1. CANARY_REQUIRES_EXECUTOR: PREPARADOR/REVISOR/APROVADOR/SUPERVISOR ⇒ 403; EXECUTOR segue para os gates normais", async () => {
    adminCookie = await bootstrapAdmin();
    const preparador = await provisionarOperadorPapeis(["PREPARADOR"]);
    const revisor = await provisionarOperadorPapeis(["REVISOR"]);
    const aprovador = await provisionarOperadorPapeis(["APROVADOR"]);
    const supervisor = await provisionarOperadorPapeis(["SUPERVISOR"]);
    const executor = await provisionarOperadorPapeis(["EXECUTOR"]);

    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);
    try {
      for (const [rotulo, cookie] of [
        ["PREPARADOR", preparador],
        ["REVISOR", revisor],
        ["APROVADOR", aprovador],
        ["SUPERVISOR", supervisor],
      ] as const) {
        const resposta = await despachar("POST", "/api/campaigns/canary-send", {
          headers: { cookie, "content-type": "application/json" },
          corpo: Buffer.from(JSON.stringify({ campanhaId: randomUUID() })),
        });
        expect(resposta.status, `papel ${rotulo} deveria ser 403`).toBe(403);
        expect(resposta.corpo).toContain("OPERATOR_ROLE_FORBIDDEN");
      }
      // EXECUTOR: a guarda de papel é SUPERADA — a execução segue para os
      // gates normais (política canarySendEnabled fechada por padrão ⇒ 409
      // CAMPAIGN_CANARY_SEND_DISABLED é a resposta esperada neste cenário).
      const executorResposta = await despachar("POST", "/api/campaigns/canary-send", {
        headers: { cookie: executor, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({ campanhaId: randomUUID() })),
      });
      expect(executorResposta.status).toBe(409);
      expect(executorResposta.corpo).toContain("CAMPAIGN_CANARY_SEND_DISABLED");
      // Nenhuma chamada de rede em NENHUM cenário da matriz.
      expect(espiaoRede).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // 03C.2A.4 — registro da cena (prova estrutural; nenhuma variável de
  // repositório é lida ou alterada — a matriz é constante do próprio teste).
  let matrizCenarioRegistrada: readonly [CenarioCanario, boolean, boolean, boolean] | undefined;
  function registroMatriz(gates: MatrizGatesCenario): void {
    const cenario = (Object.keys(MATRIZ_POLITICA_CENARIO) as CenarioCanario[]).find(
      (k) => MATRIZ_POLITICA_CENARIO[k] === gates,
    );
    matrizCenarioRegistrada = cenario
      ? [cenario, gates.canarySend, gates.execute, gates.realSend]
      : undefined;
  }

  function ambienteBase(fingerprintCanario: string, gates: MatrizGatesCenario): void {
    registroMatriz(gates);
    process.env.PF_CAMPAIGN_PROOF_KEY_BASE64 = CHAVE_PROVA_BASE64;
    process.env.PF_CAMPAIGN_CANARY_RECIPIENT_FINGERPRINT = fingerprintCanario;
    // Matriz 03C.2A.4: os TRÊS gates são explícitos por cenário — sem
    // default implícito. A: canarySend fechado (prova 409); B+C/D: abertos
    // (caminho elegível/divergente); E: TODOS fechados (readiness independe).
    process.env.PF_CAMPAIGN_CANARY_SEND_ENABLED = gates.canarySend ? "true" : "false";
    process.env.PF_CAMPAIGN_EXECUTE_ENABLED = gates.execute ? "true" : "false";
    process.env.REAL_SEND_ENABLED = gates.realSend ? "true" : "false";
    process.env.GMAIL_OAUTH_CLIENT_ID = "client-id-sintetico";
    process.env.GMAIL_OAUTH_CLIENT_SECRET = "client-secret-sintetico";
    process.env.GMAIL_OAUTH_REDIRECT_URI = "https://exemplo.test/callback";
    process.env.GMAIL_EXPECTED_ACCOUNT = CONTA_ESPERADA;
    process.env.DATA_ENCRYPTION_KEY_BASE64 = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
    // Fonte ÚNICA: a MESMA constante usada pela fixture OAuth (source match).
    process.env.DOCUMENT_FINGERPRINT_KEY_BASE64 = CHAVE_FINGERPRINT_FIXTURE_B64;
  }

  interface CenaCanario {
    campanhaId: string;
    loteCampanhaId: string;
    /** ID do item canário — agregado dos eventos EXEC_* em produção. */
    readonly itemCanarioId: string;
    fingerprints: readonly string[];
  }

  /**
   * GF3 F1 — provisiona operador com papéis EXATOS e devolve o cookie de
   * sessão (mesmo contrato admin/provision + session dos testes 2B1A-H*).
   */
  async function provisionarOperadorPapeis(papeis: readonly string[]): Promise<string> {
    const credencial = tokenSintetico("f1-" + papeis.join("-"));
    const admin = await despachar("POST", "/api/operator/admin/provision", {
      headers: { cookie: adminCookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        code: "OP-F1-" + randomUUID().slice(0, 8),
        displayName: "Operador F1 " + papeis.join("+"),
        roles: [...papeis],
        credentialHash: createHash("sha256").update(credencial).digest("hex"),
      })),
    });
    expect(admin.status).toBe(201);
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: credencial })),
    });
    expect(login.status).toBe(200);
    return firstCookie(login.headers["set-cookie"]);
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
      "INSERT INTO campanha_persistida (id, operator_id, fingerprint_arquivo, template_versao, hash_aprovacao, snapshot_registros, total_registros, total_aptos, total_bloqueados, total_aprovados, estado, criada_em, atualizada_em) VALUES ($1, $2, $3, 'pf-expedicao-carteira-2026-v2', $4, $5::jsonb, $6, $6, 0, $6, 'LOTE_CRIADO', $7, $7)",
      [campanhaId, params.operatorId, fingerprintArquivo, hashAprovacao, JSON.stringify({ registros, total: registros.length }), registros.length, agora],
    );
    await p.query(
      "INSERT INTO lote_campanha (id, campanha_id, origem, codigo, template_versao, estado, total_itens, criado_em) VALUES ($1, $2, 'PF', $3, 'pf-expedicao-carteira-2026-v2', $4, $5, $6)",
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
          // 03C.2A.5 — acao = constante canônica de produção
          // ("EXECUTAR_ITEM_CAMPANHA"), EXATAMENTE como o caso de uso
          // AUTORIZAR_EXECUCAO de produção grava: o control plane autoriza; a
          // prova humana autoriza EXECUÇÃO do item e o antirreplay verifica
          // este MESMO valor nos metadados.
          JSON.stringify({ esquema: "CAMPANHA_CONTROLE_V1", acao: ACAO_AUTORIZADA_EXECUCAO, lote_estado: "ATIVO" }),
          hashEventoTeste(eventoId, loteCampanhaId, "CAMPANHA_EXECUCAO_AUTORIZADA", agora),
        ],
      );
    }
    // 03C.2A.5 — o item canário criado pela própria cena é a autoridade dos
    // eventos EXEC_* (o MESMO id persistido em
    // CAMPANHA_CANARIO_SELECIONADO.metadados.item_id — sem fallback/heurística).
    return { campanhaId, loteCampanhaId, itemCanarioId: itemIds[0]!, fingerprints };
  }

  // E — conexões OAuth SÃO PROPRIEDADE DA SUÍTE: ids capturados via
  // RETURNING; limpeza por id (nunca DELETE global; nunca toca dados de
  // outra suíte; executa também após falha intermediária via afterEach).
  const conexoesOAuthDaSuite: string[] = [];
  let conexaoRecemInserida: string | undefined;

  // 03C.2A.3 — o helper NÃO lê env implícita: usa a MESMA constante sintética
  // do ambienteBase (FINGERPRINT_KEY_SOURCE_MATCH=true). O comportamento
  // default persiste a conta EXATAMENTE esperada (CONTA_ESPERADA, sem
  // sufixo) ⇒ DEFAULT_FINGERPRINT_MATCH=true. A unicidade entre chamadas já
  // é garantida pelo cleanup OWNED por id (afterEach) — nunca por alterar a
  // conta que deveria corresponder. O parâmetro explícito existe SOMENTE para
  // o cenário divergente (outra.conta@exemplo.test ⇒ DIVERGENT_MISMATCH=true).
  async function conectarOAuthCorrespondente(detalhe?: string): Promise<string> {
    // 03C.2A.4 — registrar o id da conexão ANTES de qualquer asserção
    // intermediária: o cleanup owned por id cobre falhas em qualquer ponto.
    conexaoRecemInserida = undefined;
    const { derivarFingerprintContaGmail } = await import("@integra-correios/mail");
    const fp = new HmacSha256Fingerprinter(Buffer.from(CHAVE_FINGERPRINT_FIXTURE_B64, "base64"));
    const alvo = detalhe ?? CONTA_ESPERADA;
    const fingerprintConta = derivarFingerprintContaGmail(fp, alvo);
    const inserida = await pool!.query(
      "INSERT INTO oauth_connection (provider, conta_fingerprint, scopes, access_token_ciphertext, access_token_nonce, access_token_auth_tag, chave_versao) VALUES ('GMAIL', $1, ARRAY['https://www.googleapis.com/auth/gmail.send']::text[], $2, $3, $4, 'v1-teste') RETURNING id",
      [fingerprintConta, Buffer.from("ciphertext-sintetico"), OAUTH_NONCE_FIXTURE, OAUTH_AUTH_TAG_FIXTURE],
    );
    const id = (inserida.rows[0] as { id: string }).id;
    conexoesOAuthDaSuite.push(id);
    conexaoRecemInserida = id;
    return id;
  }

  afterEach(async () => {
    // Limpeza OWNED: somente as linhas criadas por esta suíte (por id).
    // 03C.2A.4 — a ÚLTIMA conexão inserida é incluída mesmo que o cenário
    // falhe ANTES de qualquer asserção (failures intermediárias cobertas).
    if (conexaoRecemInserida && !conexoesOAuthDaSuite.includes(conexaoRecemInserida)) {
      conexoesOAuthDaSuite.push(conexaoRecemInserida);
    }
    for (const id of conexoesOAuthDaSuite.splice(0)) {
      await pool?.query("DELETE FROM oauth_connection WHERE id = $1 AND provider = 'GMAIL'", [id]);
    }
  });

  // 03C.2A.5 — produção agrega EXEC_* pelo ITEM (agregado_id = itemId): a
  // contagem da suíte usa a MESMA autoridade — nunca o lote, nunca "primeiro
  // evento", nunca heurística por timestamp ou redescoberta por destinatário.
  async function contagensExec(itemCanarioId: string): Promise<Record<string, number>> {
    const eventos = await pool!.query(
      "SELECT tipo, count(*)::int AS total FROM evento_auditoria WHERE agregado_tipo = 'CAMPANHA_EXECUCAO' AND agregado_id = $1 AND tipo LIKE 'EXEC%' GROUP BY tipo",
      [itemCanarioId],
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


  // -------------------------------------------------------------------
  // SLICE-03C.2B1A — runtime Gmail REAL (local, strict zero send).
  // Constantes LIVE separadas das sintéticas 03C.2A para provar
  // independência: chaves/conta/token próprios deste gate.
  // -------------------------------------------------------------------
  const CHAVE_CRIPTO_LIVE = Buffer.from("chave-cripto-live-03c2b1a".padEnd(32, "!"), "utf8"); // 32 bytes
  const CONTA_LIVE_H = "institucional.live@exemplo.test";
  const TOKEN_LIVE_H = "token-live-h-03c2b1a-sintetico";
  const VERSAO_LIVE_H = "v1-live-h";

  function ambienteLiveH(fingerprintCanario: string, canarySend: boolean): void {
    process.env.PF_CAMPAIGN_PROOF_KEY_BASE64 = CHAVE_PROVA_BASE64;
    process.env.PF_CAMPAIGN_CANARY_RECIPIENT_FINGERPRINT = fingerprintCanario;
    // Gates SINTÉTICOS DE PROCESSO: abertos SOMENTE no cenário H (teste);
    // produção continua sem qualquer flag (fail-closed, STRICT NO SEND).
    process.env.PF_CAMPAIGN_CANARY_SEND_ENABLED = canarySend ? "true" : "false";
    process.env.PF_CAMPAIGN_EXECUTE_ENABLED = canarySend ? "true" : "false";
    process.env.REAL_SEND_ENABLED = canarySend ? "true" : "false";
    process.env.GMAIL_OAUTH_CLIENT_ID = "client-id-live-h";
    process.env.GMAIL_OAUTH_CLIENT_SECRET = "client-secret-live-h";
    process.env.GMAIL_OAUTH_REDIRECT_URI = "https://exemplo.test/callback";
    process.env.GMAIL_EXPECTED_ACCOUNT = CONTA_LIVE_H;
    process.env.DOCUMENT_FINGERPRINT_KEY_BASE64 = CHAVE_FINGERPRINT_FIXTURE_B64;
    process.env.DATA_ENCRYPTION_KEY_BASE64 = CHAVE_CRIPTO_LIVE.toString("base64");
    process.env.DATA_ENCRYPTION_KEY_VERSION = VERSAO_LIVE_H;
  }

  async function inserirConexaoLiveH(): Promise<string> {
    const { derivarFingerprintContaGmail: derivar } = await import("@integra-correios/mail");
    const fpConta = derivar(new HmacSha256Fingerprinter(Buffer.from(CHAVE_FINGERPRINT_FIXTURE_B64, "base64")), CONTA_LIVE_H);
    const envelope = new Aes256GcmSecretBox(CHAVE_CRIPTO_LIVE, VERSAO_LIVE_H).seal(TOKEN_LIVE_H, "oauth:access");
    const inserida = await pool!.query(
      "INSERT INTO oauth_connection (provider, conta_fingerprint, scopes, access_token_ciphertext, access_token_nonce, access_token_auth_tag, chave_versao, expira_em) VALUES ('GMAIL', $1, ARRAY['https://www.googleapis.com/auth/gmail.send']::text[], $2, $3, $4, $5, now() + interval '1 hour') RETURNING id",
      [fpConta, Buffer.from(envelope.ciphertext), Buffer.from(envelope.nonce), Buffer.from(envelope.authTag), VERSAO_LIVE_H],
    );
    const id = (inserida.rows[0] as { id: string }).id;
    conexoesOAuthDaSuite.push(id); // cleanup OWNED existente cobre falhas
    return id;
  }

  let tokenVistoPeloTransporte: string | undefined;

  async function montarStackLiveH(cena: CenaCanario): Promise<ReturnType<typeof criarCampanhaGmailRuntime>> {
    const runtime = criarCampanhaGmailRuntime({
      env: process.env,
      pool: pool!,
      portaTransporte: async (_mensagem, accessToken) => {
        tokenVistoPeloTransporte = accessToken;
        return {
          provider: "GMAIL" as const,
          messageId: "sintetico-live-h-" + cena.itemCanarioId.slice(0, 12),
          acceptedAt: new Date().toISOString(),
        };
      },
      // Qualquer tentativa de refresh neste cenário é um BUG do resolver.
      portaRefresh: async () => {
        throw new Error("refresh proibido: access token da cena é válido");
      },
    });
    injetarProvedor!(
      new ProvedorGmailCampanha({
        pool: pool!,
        campanhaId: cena.campanhaId,
        gateway: new GmailMailGateway(runtime.transport, runtime.loadAccessToken, undefined, process.env),
      }),
    );
    return runtime;
  }

  it("2B1A-H0. ARMAMENTO FECHADO com stack Gmail REAL montada: 409 com ZERO token-load/decrypt/rede (pré-claim)", async () => {
    const credencialH0 = tokenSintetico("live-h0");
    const admin = await despachar("POST", "/api/operator/admin/provision", {
      headers: { cookie: await bootstrapAdmin(), "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        code: "OP-CNR-" + randomUUID().slice(0, 8),
        displayName: "Operador Live H0",
        roles: ["EXECUTOR"],
        credentialHash: createHash("sha256").update(credencialH0).digest("hex"),
      })),
    });
    expect(admin.status).toBe(201);
    const operatorIdH0 = (JSON.parse(admin.corpo) as { operatorId: string }).operatorId;
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: credencialH0 })),
    });
    expect(login.status).toBe(200);
    const cookieH0 = firstCookie(login.headers["set-cookie"]);
    const cena = await criarCenaCanario({
      operatorId: operatorIdH0,
      emails: ["canario.live.h0@exemplo.test"],
    });
    ambienteLiveH(cena.fingerprints[0]!, false); // TODOS os gates fechados
    await inserirConexaoLiveH();
    const runtime = await montarStackLiveH(cena);
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);
    const resposta = await despachar("POST", "/api/campaigns/canary-send", {
      headers: { cookie: cookieH0, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
    });
    expect(resposta.status).toBe(409);
    expect(resposta.corpo).toContain("CAMPAIGN_CANARY_SEND_DISABLED");
    expect(espiaoRede).not.toHaveBeenCalled();
    // PRÉ-CLAIM: zero leitura de conexão, zero decrypt, zero refresh, zero transport.
    expect(runtime.metricas.leiturasConexao()).toBe(0);
    expect(runtime.metricas.descriptografias()).toBe(0);
    expect(runtime.metricas.refreshes()).toBe(0);
    expect(runtime.metricas.chamadasTransporte()).toBe(0);
    expect(await contagensExec(cena.itemCanarioId)).toEqual({});
    expect(await estadoItem(cena.loteCampanhaId)).toBe("PREPARADO");
    injetarProvedor!(null);
  });

  it("2B1A-H0b. EXECUTE fechado isoladamente (canary=true, execute=false, real=true): zero claim/token/rede", async () => {
    const credencialH0b = tokenSintetico("live-h0b");
    const admin = await despachar("POST", "/api/operator/admin/provision", {
      headers: { cookie: await bootstrapAdmin(), "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        code: "OP-CNR-" + randomUUID().slice(0, 8),
        displayName: "Operador Live H0b",
        roles: ["EXECUTOR"],
        credentialHash: createHash("sha256").update(credencialH0b).digest("hex"),
      })),
    });
    expect(admin.status).toBe(201);
    const operatorId = (JSON.parse(admin.corpo) as { operatorId: string }).operatorId;
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: credencialH0b })),
    });
    expect(login.status).toBe(200);
    const cookie = firstCookie(login.headers["set-cookie"]);
    const cena = await criarCenaCanario({
      operatorId,
      emails: ["canario.live.h0b@exemplo.test"],
    });
    ambienteLiveH(cena.fingerprints[0]!, true);
    process.env.PF_CAMPAIGN_EXECUTE_ENABLED = "false"; // ÚNICO gate fechado
    await inserirConexaoLiveH();
    const runtime = await montarStackLiveH(cena);
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);
    const resposta = await despachar("POST", "/api/campaigns/canary-send", {
      headers: { cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
    });
    expect(resposta.status).toBe(409);
    expect(resposta.corpo).toContain("CAMPAIGN_CANARY_BLOCKED");
    expect(espiaoRede).not.toHaveBeenCalled();
    expect(runtime.metricas.leiturasConexao()).toBe(0);
    expect(runtime.metricas.descriptografias()).toBe(0);
    expect(runtime.metricas.refreshes()).toBe(0);
    expect(runtime.metricas.chamadasTransporte()).toBe(0);
    expect(await contagensExec(cena.itemCanarioId)).toEqual({});
    injetarProvedor!(null);
  });

  it("2B1A-H0c. REAL_SEND fechado isoladamente (canary=true, execute=true, real=false): zero claim/token/rede", async () => {
    const credencialH0c = tokenSintetico("live-h0c");
    const admin = await despachar("POST", "/api/operator/admin/provision", {
      headers: { cookie: await bootstrapAdmin(), "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        code: "OP-CNR-" + randomUUID().slice(0, 8),
        displayName: "Operador Live H0c",
        roles: ["EXECUTOR"],
        credentialHash: createHash("sha256").update(credencialH0c).digest("hex"),
      })),
    });
    expect(admin.status).toBe(201);
    const operatorId = (JSON.parse(admin.corpo) as { operatorId: string }).operatorId;
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: credencialH0c })),
    });
    expect(login.status).toBe(200);
    const cookie = firstCookie(login.headers["set-cookie"]);
    const cena = await criarCenaCanario({
      operatorId,
      emails: ["canario.live.h0c@exemplo.test"],
    });
    ambienteLiveH(cena.fingerprints[0]!, true);
    process.env.REAL_SEND_ENABLED = "false"; // ÚNICO gate fechado
    await inserirConexaoLiveH();
    const runtime = await montarStackLiveH(cena);
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);
    const resposta = await despachar("POST", "/api/campaigns/canary-send", {
      headers: { cookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
    });
    expect(resposta.status).toBe(409);
    expect(resposta.corpo).toContain("CAMPAIGN_CANARY_BLOCKED");
    expect(espiaoRede).not.toHaveBeenCalled();
    expect(runtime.metricas.leiturasConexao()).toBe(0);
    expect(runtime.metricas.descriptografias()).toBe(0);
    expect(runtime.metricas.refreshes()).toBe(0);
    expect(runtime.metricas.chamadasTransporte()).toBe(0);
    expect(await contagensExec(cena.itemCanarioId)).toEqual({});
    injetarProvedor!(null);
  });

  it("2B1A-H. Flags sintéticas true: caminho completo via STACK GMAIL REAL (transport fake, receipt sintético, zero rede)", async () => {
    const credencialH = tokenSintetico("live-h");
    const admin = await despachar("POST", "/api/operator/admin/provision", {
      headers: { cookie: await bootstrapAdmin(), "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        code: "OP-CNR-" + randomUUID().slice(0, 8),
        displayName: "Operador Live H",
        roles: ["EXECUTOR"],
        credentialHash: createHash("sha256").update(credencialH).digest("hex"),
      })),
    });
    expect(admin.status).toBe(201);
    const operatorIdH = (JSON.parse(admin.corpo) as { operatorId: string }).operatorId;
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: credencialH })),
    });
    expect(login.status).toBe(200);
    const cookieH = firstCookie(login.headers["set-cookie"]);
    const cena = await criarCenaCanario({
      operatorId: operatorIdH,
      emails: ["canario.live.h@exemplo.test"],
    });
    ambienteLiveH(cena.fingerprints[0]!, true); // gates sintéticos abertos (teste)
    await inserirConexaoLiveH();
    const runtime = await montarStackLiveH(cena);
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);

    const resposta = await despachar("POST", "/api/campaigns/canary-send", {
      headers: { cookie: cookieH, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
    });
    expect(resposta.status).toBe(200);
    expect(resposta.corpo).toContain("ENVIADO");
    expect(resposta.corpo).toContain("messageId");
    expect(espiaoRede).not.toHaveBeenCalled(); // ZERO rede real
    expect(tokenVistoPeloTransporte).toBe(TOKEN_LIVE_H); // token DECIFRADO chegou ao gateway
    // ACCESS_TOKEN_LOADS=1; decrypt=1; refresh=0; transport=1
    expect(runtime.metricas.leiturasConexao()).toBe(1);
    expect(runtime.metricas.descriptografias()).toBe(1);
    expect(runtime.metricas.refreshes()).toBe(0);
    expect(runtime.metricas.chamadasTransporte()).toBe(1);
    const contagens = await contagensExec(cena.itemCanarioId);
    expect(contagens["EXEC_CLAIM"]).toBe(1);
    expect(contagens["EXEC_TENTATIVA_INICIADA"]).toBe(1);
    expect(contagens["EXEC_RECEIPT"]).toBe(1);
    expect(contagens["EXEC_SETTLEMENT"]).toBe(1);
    expect(await estadoItem(cena.loteCampanhaId)).toBe("ENVIADO");

    // REPLAY — deltas ZERO (token e transport não são re-resolvidos).
    const replay = await despachar("POST", "/api/campaigns/canary-send", {
      headers: { cookie: cookieH, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
    });
    expect(replay.status).toBe(409);
    expect(replay.corpo).toContain("ITEM_NAO_PREPARADO");
    expect(runtime.metricas.leiturasConexao()).toBe(1); // SECOND_TOKEN_RESOLUTIONS=0
    expect(runtime.metricas.chamadasTransporte()).toBe(1); // SECOND_GMAIL_CALLS=0
    const contagensReplay = await contagensExec(cena.itemCanarioId);
    expect(contagensReplay["EXEC_RECEIPT"]).toBe(1); // delta 0; total 1
    expect(contagensReplay["EXEC_SETTLEMENT"]).toBe(1); // delta 0; total 1
    injetarProvedor!(null);
  });

  it("2B1A-I. Readiness NÃO carrega/descriptografa/renova token; CONNECTED ≠ token válido", async () => {
    const credencialI = tokenSintetico("live-i");
    const admin = await despachar("POST", "/api/operator/admin/provision", {
      headers: { cookie: await bootstrapAdmin(), "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        code: "OP-CNR-" + randomUUID().slice(0, 8),
        displayName: "Operador Live I",
        roles: ["EXECUTOR"],
        credentialHash: createHash("sha256").update(credencialI).digest("hex"),
      })),
    });
    expect(admin.status).toBe(201);
    const operatorIdI = (JSON.parse(admin.corpo) as { operatorId: string }).operatorId;
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: credencialI })),
    });
    expect(login.status).toBe(200);
    const cena = await criarCenaCanario({
      operatorId: operatorIdI,
      emails: ["canario.live.i@exemplo.test"],
    });
    ambienteLiveH(cena.fingerprints[0]!, false);
    await inserirConexaoLiveH();
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);
    const runtime = criarCampanhaGmailRuntime({
      env: process.env,
      pool: pool!,
      portaTransporte: async () => {
        throw new Error("transport não deveria ser invocado pelo readiness");
      },
      portaRefresh: async () => {
        throw new Error("refresh não deveria ser invocado pelo readiness");
      },
    });
    const readiness = await avaliarReadinessOauthCanario(pool!, new HmacSha256Fingerprinter(Buffer.from(CHAVE_FINGERPRINT_FIXTURE_B64, "base64")));
    expect(readiness.oauthConfigurationReady).toBe(true);
    expect(readiness.oauthConnectionStored).toBe(true);
    expect(readiness.oauthExpectedAccountConfigured).toBe(true);
    expect(readiness.oauthStoredAccountMatchesExpected).toBe(true);
    expect(readiness.oauthEncryptionConfigurationReady).toBe(true);
    expect(readiness.executionReady).toBe(true);
    // ZERO resolução de token pelo readiness (CONNECTED ≠ ACCESS_TOKEN_VALID):
    expect(runtime.metricas.leiturasConexao()).toBe(0);
    expect(runtime.metricas.descriptografias()).toBe(0);
    expect(runtime.metricas.refreshes()).toBe(0);
    expect(espiaoRede).not.toHaveBeenCalled();
  });

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

    // ORDEM OBRIGATÓRIA (03C.2A.3): 1 cena → 2 ambiente → 3 OAuth →
    // 4 provider DI → 5 rota (ENV_READY_BEFORE_OAUTH=true).
    const cena = await criarCenaCanario({
      operatorId: executorIdReal,
      emails: ["canario.rota.a@exemplo.test"],
    });
    ambienteBase(cena.fingerprints[0]!, MATRIZ_POLITICA_CENARIO.A);
    await conectarOAuthCorrespondente(); // canarySendEnabled=FALSE

    const providerEspiao = {
      nome: "ESPIA_DI",
      enviar: async () => {
        throw new Error("provider não deveria ser chamado");
      },
    };
    injetarProvedor!(providerEspiao);
    const espiaoRede = vi.fn();
    vi.stubGlobal("fetch", espiaoRede);

    const antes = await contagensExec(cena.itemCanarioId);
    const resposta = await despachar("POST", "/api/campaigns/canary-send", {
      headers: { cookie: executorCookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
    });
    expect(resposta.status).toBe(409);
    expect(resposta.corpo).toContain("CAMPAIGN_CANARY_SEND_DISABLED");
    expect(espiaoRede).not.toHaveBeenCalled();
    const depois = await contagensExec(cena.itemCanarioId);
    expect(depois).toEqual(antes);
    expect(depois["EXEC_CLAIM"] ?? 0).toBe(0); // A_EXEC_EVENT_DELTA = 0 (cena possui só eventos de controle)
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

    // ORDEM OBRIGATÓRIA (03C.2A.3): 1 cena → 2 ambiente → 3 OAuth →
    // 4 provider DI → 5 rota (ENV_READY_BEFORE_OAUTH=true).
    const cena = await criarCenaCanario({
      operatorId: operatorIdB,
      emails: ["canario.rota.b@exemplo.test"],
    });
    ambienteBase(cena.fingerprints[0]!, MATRIZ_POLITICA_CENARIO.B);
    await conectarOAuthCorrespondente(); // canarySendEnabled=TRUE

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
    const contagens = await contagensExec(cena.itemCanarioId);
    expect(contagens["EXEC_RECEIPT"]).toBe(1);
    expect(contagens["EXEC_SETTLEMENT"]).toBe(1);
    expect(await estadoItem(cena.loteCampanhaId)).toBe("ENVIADO");

    // REPLAY (C): item já ENVIADO ⇒ preflight bloqueia (ITEM_NAO_PREPARADO);
    // provider NUNCA é chamado de novo; nenhum novo receipt/settlement.
    const replay = await despachar("POST", "/api/campaigns/canary-send", {
      headers: { cookie: cookieB, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
    });
    // REPLAY — contrato do preflight vigente: item ENVIADO ⇒ 409
    // ITEM_NAO_PREPARADO. Deltas do provider e dos eventos EXEC_* = 0; os
    // TOTAIS persistidos permanecem 1 (receipt/settlement NÃO se repetem).
    expect(replay.status).toBe(409);
    expect(replay.corpo).toContain("ITEM_NAO_PREPARADO");
    expect(chamadasProvider).toBe(1); // delta de provider = 0
    const contagensReplay = await contagensExec(cena.itemCanarioId);
    expect(contagensReplay["EXEC_RECEIPT"]).toBe(1); // delta = 0; total = 1
    expect(contagensReplay["EXEC_SETTLEMENT"]).toBe(1); // delta = 0; total = 1
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

    // ORDEM OBRIGATÓRIA (03C.2A.3): 1 cena → 2 ambiente → 3 OAuth →
    // 4 provider DI → 5 rota (ENV_READY_BEFORE_OAUTH=true).
    const cena = await criarCenaCanario({
      operatorId: operatorIdD,
      emails: ["canario.rota.d@exemplo.test"],
    });
    ambienteBase(cena.fingerprints[0]!, MATRIZ_POLITICA_CENARIO.D);
    await conectarOAuthCorrespondente();
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
    const contagens = await contagensExec(cena.itemCanarioId);
    expect(contagens["EXEC_RECEIPT"]).toBeUndefined();
    expect(contagens["EXEC_CLAIM"] ?? 0).toBe(0); // D_EXEC_EVENT_DELTA = 0 (bloqueio antes do claim)
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
    ambienteBase(cena.fingerprints[0]!, MATRIZ_POLITICA_CENARIO.E);
    for (const chave of ["GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_OAUTH_REDIRECT_URI"]) {
      delete process.env[chave];
    }
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
    ambienteBase(cena.fingerprints[0]!, MATRIZ_POLITICA_CENARIO.E);
    resposta = await despachar("GET", `/api/campaigns/operational-readiness?campanhaId=${cena.campanhaId}`, {
      headers: { cookie: cookieE },
    });
    corpo = JSON.parse(resposta.corpo);
    expect(corpo.oauth.estado).toBe("NOT_CONNECTED");

    // E.3 — conexão persistida DIVERGENTE ⇒ NOT_CONNECTED (conta ≠ esperada).
    const idDivergente = await conectarOAuthCorrespondente("outra.conta@exemplo.test");
    resposta = await despachar("GET", `/api/campaigns/operational-readiness?campanhaId=${cena.campanhaId}`, {
      headers: { cookie: cookieE },
    });
    corpo = JSON.parse(resposta.corpo);
    expect(corpo.oauth.estado).toBe("NOT_CONNECTED");
    expect(corpo.oauth.connectionStored).toBe(true);
    expect(corpo.oauth.storedAccountMatchesExpected).toBe(false);

    // E.4 — revoga SOMENTE a conexão divergente OWNED (cleanup por id;
    // nunca DELETE global; nenhum dado operacional ou de outra suíte é
    // tocado) e insere a conexão com a conta EXATAMENTE esperada ⇒ CONNECTED
    // (readiness, NÃO liveness: zero refresh, zero rede, zero token).
    await pool!.query(
      "UPDATE oauth_connection SET revogada_em = now() WHERE id = $1 AND provider = 'GMAIL'",
      [idDivergente],
    );
    conexoesOAuthDaSuite.splice(conexoesOAuthDaSuite.indexOf(idDivergente), 1);
    await conectarOAuthCorrespondente();
    resposta = await despachar("GET", `/api/campaigns/operational-readiness?campanhaId=${cena.campanhaId}`, {
      headers: { cookie: cookieE },
    });
    corpo = JSON.parse(resposta.corpo);
    expect(corpo.oauth.estado).toBe("CONNECTED");

    // 03C.2A.5 — identidade do agregado: o metadado do evento canário
    // persistido pela cena carrega o MESMO itemCanarioId retornado
    // (EXEC_EVENT_AGGREGATE_MATCH=true; nenhuma redescoberta por heurística).
    const canarioPersistido = await pool!.query(
      "SELECT metadados->>'item_id' AS item_id FROM evento_auditoria WHERE agregado_tipo = 'CAMPANHA_EXECUCAO' AND tipo = 'CAMPANHA_CANARIO_SELECIONADO' AND agregado_id = $1",
      [cena.loteCampanhaId],
    );
    expect((canarioPersistido.rows[0] as { item_id: string }).item_id).toBe(cena.itemCanarioId);

    // Sanitização ESTRUTURAL (03C.2A.4): allowlist EXATA de chaves públicas
    // de corpo.oauth + varredura recursiva por campos sensíveis. tokenRefreshes
    // é telemetria numérica legítima (0) — o substring-match bruto "token" era
    // um falso-positivo e foi removido SEM diluir o contrato de sanitização.
    expect(Object.keys(corpo.oauth).sort()).toEqual([...CHAVES_OAUTH_PUBLICAS].sort());
    const camposProibidos = [
      "accesstoken",
      "refreshtoken",
      "accesstokenciphertext",
      "refreshtokenciphertext",
      "tokenciphertext",
      "nonce",
      "authtag",
      "clientsecret",
      "encryptionkey",
      "contafingerprint",
      "contaesperada",
      "token",
    ];
    expect(varrerCamposProibidos(resposta.corpo, camposProibidos)).toEqual([]);
    // Nenhum segredo-sintético da fixture vaza no corpo.
    expect(resposta.corpo).not.toContain("ciphertext-sintetico");
    // Sem conta/e-mail no JSON (contrato preservado).
    expect(resposta.corpo).not.toContain(CONTA_ESPERADA);
    expect(resposta.corpo).not.toContain("@exemplo.test");
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


describe("SLICE_03C.2B1A — fonte (SOURCE_STRUCTURE, sem DB)", () => {
  it("runtime normal da API NÃO usa mais o stub GmailMailGateway(undefined, async () => undefined)", () => {
    const fonteServer = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(fonteServer).toContain("criarCampanhaGmailRuntime({ env:");
    expect(fonteServer).toContain("new GmailMailGateway(runtime.transport, runtime.loadAccessToken");
    expect(fonteServer).not.toContain("new GmailMailGateway(undefined, async () => undefined)");
    const fonteRuntime = readFileSync(new URL("../src/campaign-gmail-runtime.ts", import.meta.url), "utf8");
    // Helper neutro: NENHUMA dependência do worker na API.
    expect(fonteRuntime).not.toContain("../../worker");
    expect(fonteRuntime).toContain("refreshOauthAccessToken");
    const fonteMail = readFileSync(new URL("../../../packages/mail/src/adapters/gmail.ts", import.meta.url), "utf8");
    expect(fonteMail).toContain("refreshPort");
  });
});

function firstCookie(header: string | readonly string[] | string[] | undefined): string {
  const valor: unknown = Array.isArray(header) ? header[0] : header;
  return typeof valor === "string" ? valor.split("\n")[0]?.split(";")[0] ?? "" : "";
}
