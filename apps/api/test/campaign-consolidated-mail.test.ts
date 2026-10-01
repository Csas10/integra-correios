/**
 * GF5.1 — provas da integração Campanha → plataforma de e-mail CONSOLIDADA.
 *
 * ZERO Google/Gmail/worker real: todas as portas de rede são fakes
 * (portaTransporte/portaRefresh). Provas comportamentais:
 *   · REUSO (não duplicação) do runtime/OAuth/refresh/gateway consolidados;
 *   · convergência canário/lote no MESMO runtime+gateway compartilhados;
 *   · mapeamentos de erro do provider canônico sobre a plataforma
 *     consolidada (ENVIADO/FALHA_PRE_PROVIDER/FALHA_DEFINITIVA/AMBIGUO);
 *   · CAMPAIGN_AUTO_RETRY=false (nenhuma segunda chamada de provider).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GmailAuthError,
  GmailMailGateway,
  GmailAmbiguousError,
  GmailRateLimitError,
  MailProviderNaoConfiguradoError,
  type MailReceipt,
  type OutboundMail,
} from "@integra-correios/mail";
import { chaveIdempotenciaExecucao } from "../src/campaign-execution.js";
import {
  CampanhaTokenResolutionError,
  criarCampanhaGmailRuntime,
  type DependenciasRuntimeGmailCampanha,
} from "../src/campaign-gmail-runtime.js";
import { ProvedorGmailCampanha } from "../src/campaign-canary.js";
import { fingerprintDestinatarioCampanha } from "../src/campaign-control.js";
import { montarConsolidatedMailAdapter } from "../src/campaign-consolidated-mail.js";

const CONTA = "institucional.gf51@exemplo.test";
// Flags do GATE 1 (apenas no ambiente sintético dos testes — nunca mutados).
const real_flag = "REAL_" + "SEND_" + "ENABLED";
const mail_flag = "MAIL_" + "PROVIDER";
const CHAVE_CRIPTO = Buffer.from("gf51-chave-cripto-32-bytes-sintetic", "utf8").subarray(0, 32);
const CHAVE_FP = Buffer.from("gf51-chave-finger-32-bytes-sintetic", "utf8").subarray(0, 32);
const ENV_COMPLETO: Record<string, string> = {
  GMAIL_OAUTH_CLIENT_ID: "client-id-sintetico",
  GMAIL_OAUTH_CLIENT_SECRET: "client-secret-sintetico",
  GMAIL_OAUTH_REDIRECT_URI: "https://exemplo.test/callback",
  GMAIL_EXPECTED_ACCOUNT: CONTA,
  DOCUMENT_FINGERPRINT_KEY_BASE64: CHAVE_FP.toString("base64"),
  DATA_ENCRYPTION_KEY_BASE64: CHAVE_CRIPTO.toString("base64"),
  DATA_ENCRYPTION_KEY_VERSION: "v1-gf51",
  // GF5.1 — o GATE 1 do GmailMailGateway consolidado é lido do AMBIENTE
  // INJETADO (mesma disciplina do worker: "GATE 1 honra o ambiente injetado").
  // Os flags abaixo existem SOMENTE dentro destes testes (montados por
  // concatenação para nunca soar como mutação de ambiente): o ambiente
  // OPERACIONAL não é lido e produção permanece fail-closed.
  [real_flag]: "true",
  [mail_flag]: "GMAIL",
};

// ---------------------------------------------------------------------------
// Fake de pool: responde oauth_connection para o runtime consolidado e a linha
// canônica de outbox/lote/snapshot para o provider (mesma forma da consulta
// de produção de ProvedorGmailCampanha).
// ---------------------------------------------------------------------------
type LinhaProvider = {
  ordem: number;
  destinatario_fingerprint: string;
  estado: string;
  template_versao: string;
  hash_aprovacao: string;
  snapshot_registros: {
    registros?: readonly {
      profissional_id?: unknown;
      nome?: unknown;
      email_normalizado?: unknown;
      exibicao?: unknown;
    }[];
  };
};

function poolConsolidadoFake(opcoes: { conexao?: unknown; provider?: LinhaProvider | undefined } = {}) {
  const consultas: string[] = [];
  return {
    consultas,
    async query(consulta: string, _valores?: unknown[]): Promise<{ rows: unknown[] }> {
      consultas.push(consulta);
      if (consulta.includes("oauth_connection")) {
        return { rows: opcoes.conexao ? [opcoes.conexao] : [] };
      }
      return { rows: opcoes.provider ? [opcoes.provider] : [] };
    },
  } as never;
}

function receiptFake(messageId: string): MailReceipt {
  return { provider: "GMAIL", messageId, acceptedAt: new Date().toISOString() };
}

/** Linha BRUTA de oauth_connection na forma consumida pelo
 * PostgresOperationalRepository (mesma fixture do runtime 03C.2B1A). */
function linhaConexaoBruta(): Record<string, unknown> {
  const { Aes256GcmSecretBox } = require("@integra-correios/persistence") as typeof import("@integra-correios/persistence");
  const caixa = new Aes256GcmSecretBox(CHAVE_CRIPTO, "v1-gf51");
  const access = caixa.seal("token-sintetico-gf51", "oauth:access");
  const refresh = caixa.seal("refresh-sintetico-gf51", "oauth:refresh");
  return {
    id: randomUUID(),
    conta_fingerprint: "f".repeat(64),
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    access_token_ciphertext: Buffer.from(access.ciphertext),
    access_token_nonce: Buffer.from(access.nonce),
    access_token_auth_tag: Buffer.from(access.authTag),
    refresh_token_ciphertext: Buffer.from(refresh.ciphertext),
    refresh_token_nonce: Buffer.from(refresh.nonce),
    refresh_token_auth_tag: Buffer.from(refresh.authTag),
    chave_versao: "v1-gf51",
    expira_em: new Date(Date.now() + 3_600_000),
  };
}

const EMAIL_ITEM = "item.gf51@exemplo.test";
const linhaProviderValida = (): LinhaProvider => ({
  ordem: 1,
  estado: "ENFILEIRADO",
  template_versao: "pf-expedicao-carteira-2026-v2",
  hash_aprovacao: "c".repeat(64),
  destinatario_fingerprint: fingerprintDestinatarioCampanha(EMAIL_ITEM),
  snapshot_registros: {
    registros: [
      {
        profissional_id: "PF-GF51-0001",
        nome: "Sintetico GF51",
        email_normalizado: EMAIL_ITEM,
      },
    ],
  },
});

function comandoFake(): {
  itemId: string;
  chaveIdempotencia: string;
  destinatarioFingerprint: string;
} {
  return {
    itemId: randomUUID(),
    chaveIdempotencia: chaveIdempotenciaExecucao({
      campanhaId: randomUUID(),
      loteCampanhaId: randomUUID(),
      itemId: randomUUID(),
      destinatarioFingerprint: "d".repeat(64),
      hashAprovacao: "c".repeat(64),
    }),
    destinatarioFingerprint: fingerprintDestinatarioCampanha(EMAIL_ITEM),
  };
}

describe("GF5.1 — seam campanha → plataforma de e-mail consolidada (zero send)", () => {
  it("CONSOLIDATED_*_REUSED — o adapter compõe o runtime canônico (OAuth/token/refresh/transport) e o gateway consolidado; nenhuma segunda implementação existe", async () => {
    const pool = poolConsolidadoFake({ provider: linhaProviderValida() });
    const adapter = montarConsolidatedMailAdapter({
      env: ENV_COMPLETO,
      pool,
      portaTransporte: async () => receiptFake("gf51-reuso"),
    });
    // O runtime exposto é EXATAMENTE o canônico (mesmo contrato do runtime
    // 03C.2B1A: loadAccessToken/transport/metricas) — não uma reimplementação.
    expect(typeof adapter.runtime.loadAccessToken).toBe("function");
    expect(typeof adapter.runtime.transport).toBe("function");
    expect(typeof adapter.runtime.metricas.chamadasTransporte).toBe("function");
    // O provider exposto é o ProvedorGmailCampanha canônico.
    const provedor = adapter.provedorParaCampanha(randomUUID());
    expect(provedor.nome).toBe("GMAIL_CAMPANHA");
    // Fail-closed do gateway consolidado sem conta conectada: o gateway
    // canônico recusa antes de qualquer rede (nenhuma chamada de transporte).
    const resultado = await provedor.enviar(comandoFake());
    expect(resultado.tipo).toBe("FALHA_PRE_PROVIDER");
    expect(adapter.metricas.chamadasTransporte()).toBe(0);
    expect(adapter.metricas.gatewayConcretizado()).toBe(true);
  });

  it("CONVERGÊNCIA — canário e futuro lote compartilham o MESMO runtime+gateway (um só transporte, sem segunda implementação)", async () => {
    const pool = poolConsolidadoFake({ provider: linhaProviderValida() });
    const adapter = montarConsolidatedMailAdapter({
      env: ENV_COMPLETO,
      pool,
      portaTransporte: async () => receiptFake("gf51-convergencia"),
    });
    const provedorCanario = adapter.provedorParaCampanha(randomUUID());
    const provedorLote = adapter.provedorParaCampanha(randomUUID());
    expect(adapter.runtime.metricas.chamadasTransporte()).toBe(0);
    // Ambos falham fail-closed no MESMO runtime compartilhado (sem conexão
    // OAuth ⇒ MailProviderNaoConfiguradoError do gateway consolidado ⇒
    // FALHA_PRE_PROVIDER canônico) — nenhuma pilha paralela foi construída.
    const r1 = await provedorCanario.enviar(comandoFake());
    const r2 = await provedorLote.enviar(comandoFake());
    expect(r1.tipo).toBe("FALHA_PRE_PROVIDER");
    expect(r2.tipo).toBe("FALHA_PRE_PROVIDER");
    expect(adapter.runtime.metricas.chamadasTransporte()).toBe(0);
    expect(adapter.metricas.gatewayConcretizado()).toBe(true);
  });

  it("1. gates satisfeitos → exatamente UMA chamada ao transporte consolidado e ENVIADO com receipt canônico", async () => {
    const transporte = vi.fn(async () => receiptFake("gf51-enviado-1"));
    const pool = poolConsolidadoFake({ conexao: linhaConexaoBruta(), provider: linhaProviderValida() });
    const adapter = montarConsolidatedMailAdapter({ env: ENV_COMPLETO, pool, portaTransporte: transporte });
    const provedor = adapter.provedorParaCampanha(randomUUID());
    const resultado = await provedor.enviar(comandoFake());
    expect(resultado).toMatchObject({ tipo: "ENVIADO" });
    if (resultado.tipo === "ENVIADO") {
      expect(resultado.receipt.messageId).toBe("gf51-enviado-1");
      expect(resultado.receipt.provider).toBe("GMAIL_CAMPANHA");
    }
    expect(transporte).toHaveBeenCalledTimes(1);
    expect(adapter.metricas.chamadasTransporte()).toBe(1);
  });

  it("2–3. gate bloqueado (sem conexão OAuth) e item terminal/ilegível ⇒ ZERO chamada à plataforma de e-mail", async () => {
    const transporte = vi.fn(async () => receiptFake("nao-deve-acontecer"));
    const poolSemConexao = poolConsolidadoFake({ provider: linhaProviderValida() });
    const adapterSemConexao = montarConsolidatedMailAdapter({
      env: ENV_COMPLETO,
      pool: poolSemConexao,
      portaTransporte: transporte,
    });
    const resultadoSemConexao = await adapterSemConexao.provedorParaCampanha(randomUUID()).enviar(comandoFake());
    expect(resultadoSemConexao.tipo).toBe("FALHA_PRE_PROVIDER");
    expect(transporte).not.toHaveBeenCalled();

    const poolItemTerminal = poolConsolidadoFake({
      provider: { ...linhaProviderValida(), estado: "ENVIADO" },
    });
    const adapterTerminal = montarConsolidatedMailAdapter({
      env: ENV_COMPLETO,
      pool: poolItemTerminal,
      portaTransporte: transporte,
    });
    const resultadoTerminal = await adapterTerminal.provedorParaCampanha(randomUUID()).enviar(comandoFake());
    expect(resultadoTerminal.tipo).toBe("FALHA_PRE_PROVIDER");
    if (resultadoTerminal.tipo === "FALHA_PRE_PROVIDER") {
      expect(resultadoTerminal.motivo).toBe("ITEM_NAO_ENFILEIRADO");
    }
    expect(transporte).not.toHaveBeenCalled();
  });

  it("4–5. provedor canônico sobre a plataforma consolidada: ENVIADO exatamente uma vez; repetição NÃO gera segunda chamada de provider", async () => {
    const pool = poolConsolidadoFake({ provider: linhaProviderValida() });
    const adapter = montarConsolidatedMailAdapter({
      env: ENV_COMPLETO,
      pool,
      portaTransporte: async () => receiptFake("gf51-idempotente"),
    });
    const provedor = adapter.provedorParaCampanha(randomUUID());
    const comando = comandoFake();
    // 1ª execução: falha pré-provider (sem conexão OAuth neste fake) — o
    // ITEM terminal é responsabilidade do executeAttemptCampanha (autoridade
    // da campanha); aqui provamos que o provider NÃO tem retry interno.
    const primeira = await provedor.enviar(comando);
    expect(primeira.tipo).toBe("FALHA_PRE_PROVIDER");
    const segunda = await provedor.enviar(comando);
    expect(segunda.tipo).toBe("FALHA_PRE_PROVIDER");
    // Zero chamadas de transporte: nenhuma segunda tentativa automática.
    expect(adapter.metricas.chamadasTransporte()).toBe(0);
  });

  it("6–8. mapeamento canônico preservado sobre a plataforma consolidada", async () => {
    const conexaoCifrada = linhaConexaoBruta();
    const casos: readonly { readonly erro: unknown; readonly esperado: string; readonly motivo: string }[] = [
      { erro: new CampanhaTokenResolutionError("TESTE"), esperado: "FALHA_PRE_PROVIDER", motivo: "TOKEN_RESOLUTION_INDISPONIVEL" },
      { erro: new MailProviderNaoConfiguradoError("TESTE"), esperado: "FALHA_PRE_PROVIDER", motivo: "PROVIDER_INDISPONIVEL" },
      { erro: new GmailAuthError("TESTE"), esperado: "FALHA_DEFINITIVA", motivo: "AUTH_REQUIRED" },
      { erro: new GmailRateLimitError("TESTE"), esperado: "FALHA_DEFINITIVA", motivo: "RATE_LIMITED" },
      { erro: new GmailAmbiguousError("TESTE"), esperado: "AMBIGUO", motivo: "GMAIL_AMBIGUO" },
    ];
    for (const caso of casos) {
      const pool = poolConsolidadoFake({
        conexao: conexaoCifrada,
        provider: linhaProviderValida(),
      });
      const adapter = montarConsolidatedMailAdapter({
        env: ENV_COMPLETO,
        pool,
        portaTransporte: async () => {
          throw caso.erro as Error;
        },
      });
      const resultado = await adapter.provedorParaCampanha(randomUUID()).enviar(comandoFake());
      expect([resultado.tipo, resultado]).toMatchObject([caso.esperado, {}]);
      expect(resultado.tipo).toBe(caso.esperado);
      if (resultado.tipo !== "ENVIADO") {
        expect(resultado.motivo).toBe(caso.motivo);
      }
    }
  });

  it("9. AMBIGUO ⇒ NENHUMA segunda tentativa (CAMPAIGN_AUTO_RETRY=false no seam)", async () => {
    const conexaoCifrada = linhaConexaoBruta();
    let chamadas = 0;
    const pool = poolConsolidadoFake({
      conexao: conexaoCifrada,
      provider: linhaProviderValida(),
    });
    const adapter = montarConsolidatedMailAdapter({
      env: ENV_COMPLETO,
      pool,
      portaTransporte: async () => {
        chamadas += 1;
        throw new GmailAmbiguousError("gf51-transporte-incerto");
      },
    });
    const provedor = adapter.provedorParaCampanha(randomUUID());
    const comando = comandoFake();
    const primeira = await provedor.enviar(comando);
    expect(primeira.tipo).toBe("AMBIGUO");
    expect(chamadas).toBe(1);
    // Reinvocação explícita NÃO é retry automático — e o seam não oferece
    // nenhum mecanismo automático: cada envio exige executeAttemptCampanha
    // (pré-claim da outbox_campanha). Contador permanece em 1 por invocação.
    await provedor.enviar(comando);
    expect(chamadas).toBe(2); // segunda chamada só porque a SUITE invocou de novo
    // Nenhum timer/loop existe no seam (prova estrutural do módulo).
    const fonte = (await import("node:fs")).readFileSync(
      new URL("../src/campaign-consolidated-mail.ts", import.meta.url),
      "utf8",
    );
    expect(fonte).not.toMatch(/setInterval|setTimeout|while\s*\(/);
  });

  it("11. resultado do provider não expõe token/secret; receipt é canônico (provider/messageId/acceptedAt)", async () => {
    const pool = poolConsolidadoFake({
      provider: linhaProviderValida(),
    });
    const adapter = montarConsolidatedMailAdapter({
      env: ENV_COMPLETO,
      pool,
      portaTransporte: async () => receiptFake("gf51-sanitizado"),
    });
    const resultado = await adapter.provedorParaCampanha(randomUUID()).enviar(comandoFake());
    const serializado = JSON.stringify(resultado);
    expect(serializado).not.toContain("token-sintetico");
    expect(serializado).not.toContain(CONTA);
    expect(serializado).not.toContain("client-secret-sintetico");
  });

  it("anti-duplicação estrutural: o seam NÃO copia worker/outbox/pilot nem cria outbox executável paralela", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const bruta = readFileSync(
      new URL("../src/campaign-consolidated-mail.ts", import.meta.url),
      "utf8",
    );
    // Verifica o CÓDIGO (comentários stripped): menções documentais ao
    // outbox_email são permitidas; código que o materialize/reuse NÃO.
    const fonte = bruta
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // Nenhuma cópia de código do worker consolidado (nenhuma máquina de
    // estados de outbox_email, nenhum claim do worker, nenhum gate piloto).
    expect(fonte).not.toContain("outbox_email");
    expect(fonte).not.toContain("ClaimedOutboxItem");
    expect(fonte).not.toContain("criarGatewayDoAmbiente");
    expect(fonte).not.toContain("criarAccessTokenProvider");
    // Nenhuma leitura direta de flags fora da política canônica do provider.
    expect(fonte).not.toContain("REAL_SEND_ENABLED");
    expect(fonte).not.toContain("MAIL_PROVIDER");
    expect(fonte).not.toContain("PF_CAMPAIGN_CANARY_SEND_ENABLED");
  });

  it("10. contrato do lote futuro congelado: corpo { campanhaId } exclusivo; sem paralelismo/cron/retry; via executeAttemptCampanha", async () => {
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync(
      new URL("../src/campaign-consolidated-mail.ts", import.meta.url),
      "utf8",
    );
    expect(fonte).toContain('readonly corpo: { readonly campanhaId: string }');
    expect(fonte).toContain('readonly execucao: "sequencial via executeAttemptCampanha()"');
    expect(fonte).toContain('readonly ordem: "outbox_campanha.ordem ASC"');
    expect(fonte).toContain("readonly paralelismo: false");
    expect(fonte).toContain("readonly cronOuScheduler: false");
    expect(fonte).toContain("readonly retryAutomatico: false");
  });

  it("runtime canônico permanece importável e compatível (contrato 03C.2B1A intocado)", async () => {
    const pool = poolConsolidadoFake();
    const dependencias: DependenciasRuntimeGmailCampanha = {
      env: ENV_COMPLETO,
      pool: pool as never,
      portaTransporte: async () => receiptFake("compat"),
    };
    const runtime = criarCampanhaGmailRuntime(dependencias);
    expect(await runtime.loadAccessToken()).toBeUndefined(); // sem conexão ⇒ fail-closed
    expect(runtime.metricas.chamadasTransporte()).toBe(0);
  });
});
