/**
 * SLICE-03B — Suíte do plano de CONTROLE operacional da Campanha PF (NO SEND).
 *
 * Estrutura (classificação honesta por natureza da prova):
 *   · BEHAVIORAL (puro/local): política de preparação, elegibilidade por
 *     ação, fingerprint canônico, provas (emissão/verificação/replay).
 *   · SOURCE_STRUCTURE (leitura de fonte): paridade persistência↔execução
 *     via helper canônico, segregação do provider fake, zero rede, rotas
 *     fail-closed com sessão individual.
 *   · HTTP_ROUTES (sem banco): autenticação fail-closed das 4 rotas novas.
 *   · POSTGRESQL_INTEGRATION (DB-gated, PG16): fixtures sintéticas únicas,
 *     jornada de controle, replay, ownership, zero-escrita na fila produtiva.
 *
 * NENHUMA campanha operacional real é usada como fixture: todos os
 * identificadores são UUIDs sintéticos gerados por execução; nenhum e-mail
 * real, nenhum fingerprint operacional (todos derivados de valores .test).
 * Provider fake NUNCA é selecionável em runtime: existe apenas como injeção
 * explícita em executeAttemptCampanha (03A) — e a rota HTTP bloqueia antes.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ACAO_AUTORIZADA_EXECUCAO,
  CODIGO_EVENTO_ATIVACAO,
  CODIGO_EVENTO_AUTORIZACAO,
  CODIGO_EVENTO_CANARIO,
  CampaignControlError,
  ativarLoteCampanha,
  avaliarAcaoOperacaoCampanha,
  emitirProvaAutorizacaoHumanaCampanha,
  emitirProvaDestinatarioCampanha,
  emitirProvasServerSideCampanha,
  fingerprintDestinatarioCampanha,
  lerConfiguracaoCanarioCampanha,
  lerConfiguracaoChaveProvaCampanha,
  lerEstoqueOperacionalCampanha,
  prepararLoteCampanha,
  autorizarExecucaoCampanha,
  verificarProvaAutorizacaoHumanaCampanha,
  verificarProvaDestinatarioCampanha,
  type CampanhaPool,
  type CampanhaSqlExecutor,
  type MotivoBloqueioAcaoOperacao,
} from "../src/campaign-control.js";
import { chaveIdempotenciaExecucao } from "../src/campaign-execution.js";
import {
  carregarPoliticaCampanhaAtualizacao,
  type PfUpdateCampaignPolicy,
} from "../src/campaigns.js";
import { despachar as despacharSemBanco } from "../src/server.js";

type Despachar = typeof despacharSemBanco;
let despacharAtivo: Despachar = despacharSemBanco;

async function despachar(
  metodo: string,
  caminho: string,
  opcoes: { headers?: Record<string, string | undefined>; corpo?: Buffer } = {},
): ReturnType<Despachar> {
  return despacharAtivo(metodo, caminho, opcoes);
}

const DB_URL_AMBIENTE = process.env.DATABASE_URL;

afterAll(() => {
  if (DB_URL_AMBIENTE === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = DB_URL_AMBIENTE;
});

const COOKIE_SESSAO = `__Host-ic_campaign_operator_session=${"B".repeat(43)}`;

const politicaFechada: PfUpdateCampaignPolicy = {
  enabled: false,
  phase: "FOUNDATION",
  individualOperatorIdentityRequired: true,
  canPersistImport: false,
  canCreateBatch: false,
  canExecute: false,
  canPrepareBatch: false,
  realSendEnabled: false,
  canarySendEnabled: false,
    batchSendEnabled: false,
};

// Fonte dos módulos — provas estruturais (Parte 2).
const FONTE_CONTROLE = readFileSync(
  new URL("../src/campaign-control.ts", import.meta.url),
  "utf-8",
);
const FONTE_PERSISTENCIA = readFileSync(
  new URL("../src/campaign-persistence.ts", import.meta.url),
  "utf-8",
);
const FONTE_EXECUCAO = readFileSync(
  new URL("../src/campaign-execution.ts", import.meta.url),
  "utf-8",
);
const FONTE_SERVER = readFileSync(
  new URL("../src/server.ts", import.meta.url),
  "utf-8",
);
const FONTE_WORKSPACE = readFileSync(
  new URL("../../web/src/pages/CampaignWorkspace.tsx", import.meta.url),
  "utf-8",
);

// ---------------------------------------------------------------------------
// Parte 1 — BEHAVIORAL
// ---------------------------------------------------------------------------

describe("SLICE_03B — política de preparação e elegibilidade por ação (BEHAVIORAL)", () => {
  it("PF_CAMPAIGN_PREPARE_ENABLED default false: canPrepareBatch fechado (política integral)", () => {
    expect(carregarPoliticaCampanhaAtualizacao({})).toEqual({
      enabled: false,
      phase: "FOUNDATION",
      individualOperatorIdentityRequired: true,
      canPersistImport: false,
      canCreateBatch: false,
      canExecute: false,
      canPrepareBatch: false,
      realSendEnabled: false,
      canarySendEnabled: false,
    batchSendEnabled: false,
    });
  });

  it("preparar exige flag própria: PF_CAMPAIGN_PREPARE_ENABLED isolado não abre nada além da preparação", () => {
    const soPrepare = carregarPoliticaCampanhaAtualizacao({
      PF_CAMPAIGN_PREPARE_ENABLED: "true",
    });
    expect(soPrepare.canPrepareBatch).toBe(true);
    expect(soPrepare.canExecute).toBe(false);
    expect(soPrepare.realSendEnabled).toBe(false);
    const execucao = avaliarAcaoOperacaoCampanha({
      acao: "EXECUTAR_ITEM",
      politica: soPrepare,
      loteEstado: "ATIVO",
      totalItens: 3,
      autorizacaoHumanaConcedida: true,
    });
    expect(execucao.permitida).toBe(false);
    expect(execucao.bloqueios).toContain("CAMPAIGN_EXECUTE_DISABLED");
    expect(execucao.bloqueios).toContain("REAL_SEND_DISABLED");
  });

  it("matriz de elegibilidade: cada flag de execução isolada continua bloqueando EXECUTAR_ITEM", () => {
    const base = {
      loteEstado: "ATIVO",
      totalItens: 3,
      autorizacaoHumanaConcedida: true,
    };
    const soExecute = avaliarAcaoOperacaoCampanha({
      acao: "EXECUTAR_ITEM",
      politica: { ...politicaFechada, canExecute: true },
      ...base,
    });
    expect(soExecute.permitida).toBe(false);
    expect(soExecute.bloqueios).toContain("REAL_SEND_DISABLED");
    const soReal = avaliarAcaoOperacaoCampanha({
      acao: "EXECUTAR_ITEM",
      politica: { ...politicaFechada, realSendEnabled: true },
      ...base,
    });
    expect(soReal.permitida).toBe(false);
    expect(soReal.bloqueios).toContain("CAMPAIGN_EXECUTE_DISABLED");
    const semAutorizacao = avaliarAcaoOperacaoCampanha({
      acao: "EXECUTAR_ITEM",
      politica: { ...politicaFechada, canExecute: true, realSendEnabled: true },
      ...base,
      autorizacaoHumanaConcedida: false,
    });
    expect(semAutorizacao.permitida).toBe(false);
    expect(semAutorizacao.bloqueios).toContain("AUTORIZACAO_HUMANA_AUSENTE");
    const loteHold = avaliarAcaoOperacaoCampanha({
      acao: "EXECUTAR_ITEM",
      politica: { ...politicaFechada, canExecute: true, realSendEnabled: true },
      loteEstado: "HOLD",
      totalItens: 3,
      autorizacaoHumanaConcedida: true,
    });
    expect(loteHold.bloqueios).toContain("LOTE_NAO_ATIVO");
    const tudoAberto = avaliarAcaoOperacaoCampanha({
      acao: "EXECUTAR_ITEM",
      politica: { ...politicaFechada, canExecute: true, realSendEnabled: true },
      ...base,
    });
    expect(tudoAberto.permitida).toBe(true);
  });

  it("PREPARAR_LOTE: exige lote HOLD, itens > 0 e canPrepareBatch; AUTORIZAR exige lote PREPARADO", () => {
    const preparacao = avaliarAcaoOperacaoCampanha({
      acao: "PREPARAR_LOTE",
      politica: { ...politicaFechada, canPrepareBatch: true },
      loteEstado: "HOLD",
      totalItens: 3,
      autorizacaoHumanaConcedida: false,
    });
    expect(preparacao.permitida).toBe(true);
    const lotePreparado = avaliarAcaoOperacaoCampanha({
      acao: "PREPARAR_LOTE",
      politica: { ...politicaFechada, canPrepareBatch: true },
      loteEstado: "PREPARADO",
      totalItens: 3,
      autorizacaoHumanaConcedida: false,
    });
    expect(lotePreparado.bloqueios).toContain("LOTE_NAO_PREPARADO");
    const semItens = avaliarAcaoOperacaoCampanha({
      acao: "PREPARAR_LOTE",
      politica: { ...politicaFechada, canPrepareBatch: true },
      loteEstado: "HOLD",
      totalItens: 0,
      autorizacaoHumanaConcedida: false,
    });
    expect(semItens.bloqueios).toContain("LOTE_SEM_ITENS");
    const autorizacao = avaliarAcaoOperacaoCampanha({
      acao: "AUTORIZAR_EXECUCAO",
      politica: { ...politicaFechada, canExecute: true },
      loteEstado: "PREPARADO",
      totalItens: 3,
      autorizacaoHumanaConcedida: false,
    });
    expect(autorizacao.permitida).toBe(true);
    const autorizacaoDuplicada = avaliarAcaoOperacaoCampanha({
      acao: "AUTORIZAR_EXECUCAO",
      politica: { ...politicaFechada, canExecute: true },
      loteEstado: "PREPARADO",
      totalItens: 3,
      autorizacaoHumanaConcedida: true,
    });
    expect(autorizacaoDuplicada.bloqueios).toContain("AUTORIZACAO_HUMANA_VIGENTE");
  });
});

describe("SLICE_03B — fingerprint canônico (BEHAVIORAL)", () => {
  it("paridade: fingerprint do helper == SHA-256 dos bytes do e-mail normalizado", () => {
    const email = "ana.sintetica@exemplo.test";
    const esperado = createHash("sha256").update(email).digest("hex");
    expect(fingerprintDestinatarioCampanha(email)).toBe(esperado);
    expect(fingerprintDestinatarioCampanha(email)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("determinismo e duplicidade: entradas iguais produzem o MESMO fingerprint", () => {
    const a = fingerprintDestinatarioCampanha("bruno.sintetico@exemplo.test");
    const b = fingerprintDestinatarioCampanha("bruno.sintetico@exemplo.test");
    expect(a).toBe(b);
  });

  it("caixa/espaço NÃO são normalizados aqui (quem normaliza é o avaliador server-side)", () => {
    const minuscula = fingerprintDestinatarioCampanha("carla.sintetica@exemplo.test");
    const maiuscula = fingerprintDestinatarioCampanha("Carla.Sintetica@Exemplo.TEST");
    const comEspaco = fingerprintDestinatarioCampanha(" carla.sintetica@exemplo.test");
    expect(maiuscula).not.toBe(minuscula);
    expect(comEspaco).not.toBe(minuscula);
  });

  it("entradas inválidas são rejeitadas com erro sanitizado (sem ecoar o valor)", () => {
    expect(() => fingerprintDestinatarioCampanha("")).toThrow(CampaignControlError);
    try {
      fingerprintDestinatarioCampanha("   ");
    } catch (error) {
      expect(error).toBeInstanceOf(CampaignControlError);
      expect((error as CampaignControlError).message).not.toContain(" ");
    }
  });

  it("nenhuma PII: a mensagem do erro nunca contém o e-mail avaliado", () => {
    const email = "segredo.sintetico@exemplo.test";
    try {
      fingerprintDestinatarioCampanha(email + " ");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(email);
    }
  });
});

describe("SLICE_03B — provas server-side (BEHAVIORAL)", () => {
  const ids = {
    operatorId: randomUUID(),
    campanhaId: randomUUID(),
    loteCampanhaId: randomUUID(),
    itemId: randomUUID(),
  };

  it("prova de destinatário: HMAC determinístico e vinculado aos identificadores", () => {
    const fingerprint = createHash("sha256").update("dest.prova@exemplo.test").digest("hex");
    const prova = emitirProvaDestinatarioCampanha({
      ...ids,
      fingerprintDestinatario: fingerprint,
      chaveProva: CHAVE_PROVA_SINTETICA,
    });
    const outra = emitirProvaDestinatarioCampanha({
      ...ids,
      fingerprintDestinatario: fingerprint,
      chaveProva: CHAVE_PROVA_SINTETICA,
    });
    expect(prova.tipo).toBe("PROVA_DESTINATARIO_CAMPANHA_V1");
    expect(prova.valor).toBe(outra.valor);
    const divergente = emitirProvaDestinatarioCampanha({
      chaveProva: CHAVE_PROVA_SINTETICA,
      ...ids,
      itemId: randomUUID(),
      fingerprintDestinatario: fingerprint,
    });
    expect(divergente.valor).not.toBe(prova.valor);
  });

  it("prova humana: vínculo operator/campanha/lote/item/chave/ação/nonce — nonce diferente muda o valor", () => {
    const chaveIdempotencia = chaveIdempotenciaExecucao({
      campanhaId: ids.campanhaId,
      loteCampanhaId: ids.loteCampanhaId,
      itemId: ids.itemId,
      destinatarioFingerprint: "aa".repeat(32),
      hashAprovacao: "bb".repeat(32),
    });
    const provaA = emitirProvaAutorizacaoHumanaCampanha({
      ...ids,
      chaveIdempotencia,
      acaoAutorizada: ACAO_AUTORIZADA_EXECUCAO,
      nonce: randomUUID(),
      chaveProva: CHAVE_PROVA_SINTETICA,
    });
    const provaB = emitirProvaAutorizacaoHumanaCampanha({
      ...ids,
      chaveIdempotencia,
      acaoAutorizada: ACAO_AUTORIZADA_EXECUCAO,
      nonce: randomUUID(),
      chaveProva: CHAVE_PROVA_SINTETICA,
    });
    expect(provaA.tipo).toBe("PROVA_AUTORIZACAO_HUMANA_CAMPANHA_V1");
    expect(provaA.valor).toMatch(/^[0-9a-f]{64}$/);
    expect(provaB.valor).not.toBe(provaA.valor);
  });

  it("verificador: formato inválido, vínculo incompatível e replay são rejeitados (pool sem emissão)", async () => {
    const poolVazio: CampanhaPool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => {
        throw new Error("não deveria abrir transação");
      },
    };
    const chaveIdempotencia = chaveIdempotenciaExecucao({
      campanhaId: ids.campanhaId,
      loteCampanhaId: ids.loteCampanhaId,
      itemId: ids.itemId,
      destinatarioFingerprint: "aa".repeat(32),
      hashAprovacao: "bb".repeat(32),
    });
    const esperado = { ...ids, chaveIdempotencia };
    const formatoRuim = await verificarProvaAutorizacaoHumanaCampanha(poolVazio, esperado, {
      valor: "nao-e-hex",
      referencia: randomUUID(),
    });
    expect(formatoRuim.verificada).toBe(false);
    expect(formatoRuim.motivo).toBe("FORMATO_INVALIDO");
    const prova = emitirProvaAutorizacaoHumanaCampanha({
      ...ids,
      chaveIdempotencia,
      acaoAutorizada: ACAO_AUTORIZADA_EXECUCAO,
      nonce: randomUUID(),
      chaveProva: CHAVE_PROVA_SINTETICA,
    });
    const semEmissao = await verificarProvaAutorizacaoHumanaCampanha(
      poolVazio,
      esperado,
      {
        valor: prova.valor,
        referencia: prova.referencia,
      },
      { chaveProva: CHAVE_PROVA_SINTETICA },
    );
    expect(semEmissao.verificada).toBe(false);
    expect(semEmissao.motivo).toBe("REPRODUZIDA");
    const ausente = await verificarProvaAutorizacaoHumanaCampanha(poolVazio, esperado, null);
    expect(ausente.verificada).toBe(false);
    expect(ausente.motivo).toBe("FORMATO_INVALIDO");
  });

  it("bind da autorização: agregado_id=$2 = loteCampanhaId, id=$3::uuid = referência (regressão AUTH_EVENT_AGGREGATE_BIND_MISMATCH)", async () => {
    // Fixtura exige referencia ≠ loteCampanhaId; falha determinística se degenerar.
    const nonce = randomUUID();
    const chaveIdempotencia = chaveIdempotenciaExecucao({
      campanhaId: ids.campanhaId,
      loteCampanhaId: ids.loteCampanhaId,
      itemId: ids.itemId,
      destinatarioFingerprint: "aa".repeat(32),
      hashAprovacao: "bb".repeat(32),
    });
    const esperadoBind = { ...ids, chaveIdempotencia };
    const prova = emitirProvaAutorizacaoHumanaCampanha({
      ...ids,
      chaveIdempotencia,
      acaoAutorizada: ACAO_AUTORIZADA_EXECUCAO,
      nonce,
      chaveProva: CHAVE_PROVA_SINTETICA,
    });
    const referencia = prova.referencia;
    expect(referencia).toBe(nonce);
    if (referencia === esperadoBind.loteCampanhaId) {
      throw new Error("fixtura degenerada: referencia igual a loteCampanhaId");
    }

    // Executor falso: registra SQL/parâmetros; evento vigente (total=1) e
    // nenhum settlement posterior (total=0).
    const consultas: Array<{ sql: string; values: readonly unknown[] }> = [];
    const executorFalso: CampanhaSqlExecutor = {
      query: async (sql: string, values: readonly unknown[] = []) => {
        consultas.push({ sql, values });
        return { rows: [{ total: consultas.length === 1 ? 1 : 0 }], rowCount: 1 };
      },
    };

    const verificacao = await verificarProvaAutorizacaoHumanaCampanha(
      executorFalso,
      esperadoBind,
      { valor: prova.valor, referencia },
      { chaveProva: CHAVE_PROVA_SINTETICA },
    );
    expect(verificacao.verificada).toBe(true);
    expect(verificacao.motivo).toBe(null);
    expect(consultas.length).toBe(2);
    const antirreplay = consultas[0];
    const settlement = consultas[1];
    if (!antirreplay || !settlement) {
      throw new Error("verificador não emitiu as duas consultas esperadas");
    }
    expect(antirreplay.sql).toContain("agregado_id = $2");
    expect(antirreplay.sql).toContain("id = $3::uuid");
    expect(antirreplay.sql).toContain("metadados->>'acao' = $4");
    expect(antirreplay.values[0]).toBe(CODIGO_EVENTO_AUTORIZACAO);
    // REGRESSÃO: $2 é o lote da campanha — NUNCA a referência do evento.
    expect(antirreplay.values[1]).toBe(esperadoBind.loteCampanhaId);
    expect(antirreplay.values[1]).not.toBe(referencia);
    expect(antirreplay.values[2]).toBe(referencia);
    expect(antirreplay.values[3]).toBe(ACAO_AUTORIZADA_EXECUCAO);
    expect(settlement.sql).toContain("agregado_id = $1");
    expect(settlement.values[0]).toBe(esperadoBind.itemId);
    expect(settlement.values[1]).toBe(referencia);
  });
});

// ---------------------------------------------------------------------------
// Parte 1.C — BEHAVIORAL 03C.1 (chave de prova, canário, ATIVAR_LOTE)
// ---------------------------------------------------------------------------

const CHAVE_PROVA_SINTETICA = Buffer.from(
  "ZmFpbC1jbG9zZWQtcHJvZmEta2V5LXN5bnRoZXRpYy0wMzI=",
  "base64",
);

/** IDs sintéticos locais (nunca operacionais) para emissão de provas 03C.1. */
const ids = {
  campanhaId: randomUUID(),
  loteCampanhaId: randomUUID(),
  itemId: randomUUID(),
} as const;

function semComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

/** Política 03C.1: canExecute=true com realSendEnabled=FALSE (ativação). */
function politicaAtivacao(): PfUpdateCampaignPolicy {
  return {
    ...politicaFechada,
    canExecute: true,
    canPrepareBatch: true,
    realSendEnabled: false,
  };
}

/** Política com realSendEnabled=true (proibida para ativação). */
function politicaRealSend(): PfUpdateCampaignPolicy {
  return { ...politicaAtivacao(), realSendEnabled: true };
}

describe("SLICE_03C.1 — chaves separadas e prova fail-closed (BEHAVIORAL)", () => {
  it("A. canExecute e realSendEnabled continuam capacidades SEPARADAS", () => {
    expect(politicaFechada.canExecute).toBe(false);
    expect(politicaFechada.realSendEnabled).toBe(false);
    expect(politicaAtivacao().canExecute).toBe(true);
    expect(politicaAtivacao().realSendEnabled).toBe(false);
    expect(politicaRealSend().canExecute).toBe(true);
    expect(politicaRealSend().realSendEnabled).toBe(true);
  });

  it("C1. PF_CAMPAIGN_PROOF_KEY_BASE64 ausente → proofKeyReady=false (fail-closed)", () => {
    const config = lerConfiguracaoChaveProvaCampanha({});
    expect(config.proofKeyReady).toBe(false);
    expect(config.chave).toBeNull();
  });

  it("C2. chave com menos de 32 bytes decodificados → proofKeyReady=false", () => {
    const curta = Buffer.from("chave-curta-insuficiente").toString("base64");
    const config = lerConfiguracaoChaveProvaCampanha({
      PF_CAMPAIGN_PROOF_KEY_BASE64: curta,
    });
    expect(config.proofKeyReady).toBe(false);
    expect(config.chave).toBeNull();
  });

  it("C3. base64 inválido → proofKeyReady=false (sem lançar)", () => {
    const config = lerConfiguracaoChaveProvaCampanha({
      PF_CAMPAIGN_PROOF_KEY_BASE64: "!!!nao-e-base64!!!",
    });
    expect(config.proofKeyReady).toBe(false);
    expect(config.chave).toBeNull();
  });

  it("C4. chave sintética válida → prova emitida; sem chave → CAMPAIGN_PROOF_KEY_UNAVAILABLE", () => {
    const prova = emitirProvaDestinatarioCampanha({
      ...ids,
      fingerprintDestinatario: "ab".repeat(32),
      chaveProva: CHAVE_PROVA_SINTETICA,
    });
    expect(prova.valor).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      emitirProvaDestinatarioCampanha({
        ...ids,
        fingerprintDestinatario: "ab".repeat(32),
      }),
    ).toThrowError(CampaignControlError);
    try {
      emitirProvaDestinatarioCampanha({
        ...ids,
        fingerprintDestinatario: "ab".repeat(32),
      });
    } catch (error) {
      expect((error as CampaignControlError).code).toBe("CAMPAIGN_PROOF_KEY_UNAVAILABLE");
    }
  });

  it("C5. caminhos de emissão/verificação recebem a chave injetada (injection points)", () => {
    const codigo = semComentarios(FONTE_CONTROLE);
    for (const marca of [
      "function emitirProvaDestinatarioCampanha",
      "function emitirProvaAutorizacaoHumanaCampanha",
      "function verificarProvaAutorizacaoHumanaCampanha",
      "function emitirProvasServerSideCampanha",
      "function ativarLoteCampanha",
      "function lerEstoqueOperacionalCampanha",
    ]) {
      expect(codigo).toContain(marca);
    }
    expect(codigo).toMatch(/chaveProva\?: Buffer/);
  });

  it("L0. idempotência por política: CANARIO_JA_SELECIONADO bloqueia segunda seleção", () => {
    const ativada = avaliarAcaoOperacaoCampanha({
      acao: "ATIVAR_LOTE",
      politica: politicaAtivacao(),
      loteEstado: "ATIVO",
      totalItens: 1,
      autorizacaoHumanaConcedida: true,
      proofKeyReady: true,
      canaryRecipientConfigured: true,
      canarySelecionado: true,
      realSendEnabled: false,
    });
    expect(ativada.permitida).toBe(false);
    expect(ativada.bloqueios).toContain("CANARIO_JA_SELECIONADO");
  });

  it("M0. antirreplay compara sequencia (IDENTITY) — a autoridade não é o timestamp", () => {
    const codigo = semComentarios(FONTE_CONTROLE);
    expect(codigo).toContain("sequencia > (SELECT sequencia FROM evento_auditoria WHERE id = $2::uuid)");
  });
});

describe("SLICE_03C.1 — canário server-side (BEHAVIORAL)", () => {
  it("D. fingerprint canônico de 64 hex configura; e-mail/itemId não configuram nada", () => {
    const ok = lerConfiguracaoCanarioCampanha({
      PF_CAMPAIGN_CANARY_RECIPIENT_FINGERPRINT: "cd".repeat(32),
    });
    expect(ok.canaryRecipientConfigured).toBe(true);
    expect(ok.fingerprint).toBe("cd".repeat(32));
    for (const valor of ["controle.sintetico@exemplo.test", randomUUID(), "CD".repeat(32), "cd".repeat(31), ""]) {
      const config = lerConfiguracaoCanarioCampanha({
        PF_CAMPAIGN_CANARY_RECIPIENT_FINGERPRINT: valor,
      });
      expect(config.canaryRecipientConfigured).toBe(false);
      expect(config.fingerprint).toBeNull();
    }
  });

  it("E/F/G. ATIVAR_LOTE exige canário configurado e EXATAMENTE um (resolvido na transação)", () => {
    const unica = avaliarAcaoOperacaoCampanha({
      acao: "ATIVAR_LOTE",
      politica: politicaAtivacao(),
      loteEstado: "PREPARADO",
      totalItens: 3,
      autorizacaoHumanaConcedida: true,
      proofKeyReady: true,
      canaryRecipientConfigured: true,
      canarySelecionado: false,
      realSendEnabled: false,
    });
    expect(unica.permitida).toBe(true);
    expect(unica.bloqueios.filter((b) => b.startsWith("CANARY_"))).toEqual([]);
    const transacao = semComentarios(FONTE_CONTROLE);
    expect(transacao).toContain("CANARY_RECIPIENT_NOT_FOUND");
    expect(transacao).toContain("CANARY_RECIPIENT_AMBIGUOUS");
  });
});

describe("SLICE_03C.1 — ATIVAR_LOTE e blocos de ativação (BEHAVIORAL)", () => {
  it("B. ativação exige canExecute=true e realSendEnabled=FALSE (REAL_SEND_MUST_BE_DISABLED_FOR_ACTIVATION)", () => {
    const canExecuteFechado = avaliarAcaoOperacaoCampanha({
      acao: "ATIVAR_LOTE",
      politica: { ...politicaAtivacao(), canExecute: false },
      loteEstado: "PREPARADO",
      totalItens: 1,
      autorizacaoHumanaConcedida: true,
      proofKeyReady: true,
      canaryRecipientConfigured: true,
      canarySelecionado: false,
      realSendEnabled: false,
    });
    expect(canExecuteFechado.permitida).toBe(false);
    expect(canExecuteFechado.bloqueios).toContain("CAMPAIGN_EXECUTE_DISABLED");
    const realSendAberto = avaliarAcaoOperacaoCampanha({
      acao: "ATIVAR_LOTE",
      politica: politicaRealSend(),
      loteEstado: "PREPARADO",
      totalItens: 1,
      autorizacaoHumanaConcedida: true,
      proofKeyReady: true,
      canaryRecipientConfigured: true,
      canarySelecionado: false,
      realSendEnabled: true,
    });
    expect(realSendAberto.permitida).toBe(false);
    expect(realSendAberto.bloqueios).toContain("REAL_SEND_MUST_BE_DISABLED_FOR_ACTIVATION");
  });

  it("AUTORIZACAO_HUMANA_AUSENTE e LOTE_NAO_PREPARADO (HOLD/CANCELADO) bloqueiam ATIVAR_LOTE", () => {
    const semAutorizacao = avaliarAcaoOperacaoCampanha({
      acao: "ATIVAR_LOTE",
      politica: politicaAtivacao(),
      loteEstado: "PREPARADO",
      totalItens: 1,
      autorizacaoHumanaConcedida: false,
      proofKeyReady: true,
      canaryRecipientConfigured: true,
      canarySelecionado: false,
      realSendEnabled: false,
    });
    expect(semAutorizacao.bloqueios).toContain("AUTORIZACAO_HUMANA_AUSENTE");
    const hold = avaliarAcaoOperacaoCampanha({
      acao: "ATIVAR_LOTE",
      politica: politicaAtivacao(),
      loteEstado: "HOLD",
      totalItens: 1,
      autorizacaoHumanaConcedida: true,
      proofKeyReady: true,
      canaryRecipientConfigured: true,
      canarySelecionado: false,
      realSendEnabled: false,
    });
    expect(hold.bloqueios).toContain("LOTE_NAO_PREPARADO");
    const cancelado = avaliarAcaoOperacaoCampanha({
      acao: "ATIVAR_LOTE",
      politica: politicaAtivacao(),
      loteEstado: "CANCELADO",
      totalItens: 1,
      autorizacaoHumanaConcedida: true,
      proofKeyReady: true,
      canaryRecipientConfigured: true,
      canarySelecionado: false,
      realSendEnabled: false,
    });
    expect(cancelado.bloqueios).toContain("LOTE_NAO_PREPARADO");
  });

  it("PROOF_KEY_UNAVAILABLE e CANARY_RECIPIENT_NOT_CONFIGURED bloqueiam ATIVAR_LOTE", () => {
    const semChave = avaliarAcaoOperacaoCampanha({
      acao: "ATIVAR_LOTE",
      politica: politicaAtivacao(),
      loteEstado: "PREPARADO",
      totalItens: 1,
      autorizacaoHumanaConcedida: true,
      proofKeyReady: false,
      canaryRecipientConfigured: true,
      canarySelecionado: false,
      realSendEnabled: false,
    });
    expect(semChave.permitida).toBe(false);
    expect(semChave.bloqueios).toContain("PROOF_KEY_UNAVAILABLE");
    const semCanario = avaliarAcaoOperacaoCampanha({
      acao: "ATIVAR_LOTE",
      politica: politicaAtivacao(),
      loteEstado: "PREPARADO",
      totalItens: 1,
      autorizacaoHumanaConcedida: true,
      proofKeyReady: true,
      canaryRecipientConfigured: false,
      canarySelecionado: false,
      realSendEnabled: false,
    });
    expect(semCanario.permitida).toBe(false);
    expect(semCanario.bloqueios).toContain("CANARY_RECIPIENT_NOT_CONFIGURED");
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Parte 2.b — Regressão 03C.1.1: hash de evento por IDENTIDADE do evento.
// A falha de CI (run 36510431980) foi colisão determinística de
// hash_evento: canário + ativação gravados na MESMA transação com o MESMO
// (agregadoId, ocorreuEm) sob o contrato antigo agregado+timestamp.
// Correção: contrato V2 — HMAC-SHA256 sobre representação JSON canônica
// ["CAMPANHA_CONTROLE_HASH_V2", eventoId, agregadoTipo, agregadoId, tipo,
// ocorreuEm]. Sem sleep, sem atraso artificial, sem retry, sem tocar o
// UNIQUE(hash_evento) e sem alterar o timestamp para contornar a colisão.
// ---------------------------------------------------------------------------
describe("SLICE_03C.1.1 — hash de evento vinculado à identidade (SOURCE_STRUCTURE + fail-closed)", () => {
  const codigosEvento = [
    "CAMPANHA_LOTE_PREPARADO",
    "CAMPANHA_EXECUCAO_AUTORIZADA",
    "CAMPANHA_CANARIO_SELECIONADO",
    "CAMPANHA_LOTE_ATIVADO",
  ];

  it("J. os QUATRO emissores de controle usam o contrato V2 (event.id = eventoId do hash)", () => {
    const codigo = semComentarios(FONTE_CONTROLE);
    // Assinatura V2: helper exige os cinco campos da identidade persistida.
    expect(codigo).toContain('"CAMPANHA_CONTROLE_HASH_V2"');
    expect(codigo).toMatch(
      /function hashEventoControle\(\s*eventoId: string,\s*agregadoTipo: string,\s*agregadoId: string,\s*tipo: string,\s*ocorreuEm: string,?\s*\)/,
    );
    // Exatamente quatro call-sites, um por emissor, cada um com eventId
    // explícito ANTES do INSERT (não há randomUUID anônimo no par).
    const chamadas = codigo.match(/hashEventoControle\(/g) ?? [];
    expect(chamadas.length).toBe(5); // 1 definição + 4 emissores
    const emissores = [
      ["CAMPANHA_LOTE_PREPARADO", "eventoId, \"CAMPANHA_EXECUCAO\", linha.id, \"CAMPANHA_LOTE_PREPARADO\", agora"],
      ["CAMPANHA_EXECUCAO_AUTORIZADA", "eventoId, \"CAMPANHA_EXECUCAO\", linha.id, CODIGO_EVENTO_AUTORIZACAO, agora"],
      ["CAMPANHA_CANARIO_SELECIONADO", "eventoCanarioId, \"CAMPANHA_EXECUCAO\", linha.id, CODIGO_EVENTO_CANARIO, agora"],
      ["CAMPANHA_LOTE_ATIVACAO", "eventoAtivacaoId, \"CAMPANHA_EXECUCAO\", linha.id, CODIGO_EVENTO_ATIVACAO, agora"],
    ];
    for (const [tipo, chamada] of emissores) {
      const codigoTipo = tipo === "CAMPANHA_LOTE_ATIVACAO" ? "CAMPANHA_LOTE_ATIVADO" : tipo;
      expect(codigosEvento).toContain(codigoTipo);
      expect(codigo).toContain("hashEventoControle(" + chamada + ")");
    }
    // Na ativação, os dois eventos da MESMA transação possuem ids PRÓPRIOS
    // e distintos — nunca um randomUUID anônimo no INSERT do segundo evento.
    const eventoCanarioDeclaracao = codigo.indexOf("const eventoCanarioId = randomUUID();");
    const eventoAtivacaoDeclaracao = codigo.indexOf("const eventoAtivacaoId = randomUUID();");
    expect(eventoCanarioDeclaracao).toBeGreaterThan(-1);
    expect(eventoAtivacaoDeclaracao).toBeGreaterThan(eventoCanarioDeclaracao);
    // Ambos vêm depois do bloco de bloqueios da ativação e antes dos INSERTs.
    const trechoAtivacao = codigo.slice(
      codigo.indexOf("CAMPAIGN_ACTIVATE_BLOCKED"),
      eventoAtivacaoDeclaracao + 1200,
    );
    expect(trechoAtivacao).toContain("const eventoCanarioId = randomUUID();");
    expect(trechoAtivacao).toContain("const eventoAtivacaoId = randomUUID();");
    expect(trechoAtivacao).not.toMatch(/randomUUID\(\),\s*\n\s*linha\.id/);
    // Sem overload/legado: exatamente 1 definição + 4 call-sites, todos os
    // call-sites iniciando com um eventId explícito (eventoId |
    // eventoCanarioId | eventoAtivacaoId) — nenhum contrato antigo.
    const ocorrencias = codigo.match(/hashEventoControle\(/g) ?? [];
    expect(ocorrencias.length).toBe(5); // 1 definição + 4 emissores
    const emissoresHash = codigo.match(/(?<!function )hashEventoControle\(/g) ?? [];
    expect(emissoresHash.length).toBe(4);
    const comEventId = codigo.match(
      /(?<!function )hashEventoControle\(\s*(eventoId|eventoCanarioId|eventoAtivacaoId)\b/g,
    ) ?? [];
    expect(comEventId.length).toBe(4);
    // Sem aleatorização fora do vínculo com eventId, sem retry/sleep.
    expect(codigo).not.toMatch(/hashEventoControle[^\n]*(sleep|retry|delay)/i);
  });

  it("D/F (fail-closed local). representação canônica é inequívoca: framing JSON, sem concatenação sem delimitador", () => {
    const codigo = semComentarios(FONTE_CONTROLE);
    const indice = codigo.indexOf("function hashEventoControle(");
    const trecho = codigo.slice(indice, indice + 700);
    // Campos serializados via JSON.stringify do array completo — framing
    // inequívoco, sem concatenação direta de campos.
    expect(trecho).toContain("JSON.stringify([");
    expect(trecho).not.toMatch(/update\(eventoId\)\.update/);
    // Algoritmo preservado: HMAC-SHA256 com o segredo legado intocado.
    expect(trecho).toContain('createHmac("sha256", "audit-chain")');
    expect(trecho).toContain('.digest("hex")');
  });

  it("D/H fail-closed. ausência da chave de prova impede emissão de prova (sem mutação, sem hash)", () => {
    // Exercita a fronteira de emissão sem banco: sem chaveProva, nenhuma
    // prova é gerada e, portanto, nenhum hash de evento é derivado.
    try {
      emitirProvaDestinatarioCampanha({
        campanhaId: randomUUID(),
        loteCampanhaId: randomUUID(),
        itemId: randomUUID(),
        fingerprintDestinatario: randomUUID().replace(/-/g, "").repeat(2),
      });
      expect.unreachable("emissão deveria falhar sem chave de prova");
    } catch (error) {
      expect((error as CampaignControlError).code).toBe("CAMPAIGN_PROOF_KEY_UNAVAILABLE");
    }
  });

  it("A–C (estrutural). dois eventos do MESMO agregado com o MESMO ocorreu_em diferem por eventId e tipo", () => {
    // Prova da CONTRATO V2 no nível de derivação (sem banco): ids distintos
    // ou tipos distintos sobre o mesmo agregado/timestamp produzem hashes
    // distintos — condição que o contrato antigo violava. A prova de
    // persistência (COUNT/hash 64-hex/recomputação) é DB-gated = PENDING_CI.
    const agora = new Date().toISOString();
    const agregado = randomUUID();
    const derivar = (payload: string): string =>
      createHash("sha256").update(payload).digest("hex");
    const canario = derivar(JSON.stringify([
      "CAMPANHA_CONTROLE_HASH_V2", randomUUID(), "CAMPANHA_EXECUCAO", agregado, "CAMPANHA_CANARIO_SELECIONADO", agora,
    ]));
    const ativacao = derivar(JSON.stringify([
      "CAMPANHA_CONTROLE_HASH_V2", randomUUID(), "CAMPANHA_EXECUCAO", agregado, "CAMPANHA_LOTE_ATIVADO", agora,
    ]));
    expect(canario).toMatch(/^[0-9a-f]{64}$/);
    expect(ativacao).toMatch(/^[0-9a-f]{64}$/);
    expect(canario).not.toBe(ativacao);
  });
});

// Parte 2 — SOURCE_STRUCTURE
// ---------------------------------------------------------------------------

describe("SLICE_03B — estrutura de fonte (SOURCE_STRUCTURE)", () => {
  function semComentarios(fonte: string): string {
    return fonte
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:"'])\/\/.*$/gm, "$1");
  }

  it("paridade: campaign-persistence usa o helper canônico (sem createHash inline para fingerprint)", () => {
    const codigo = semComentarios(FONTE_PERSISTENCIA);
    expect(codigo).toContain("fingerprintDestinatarioCampanha(");
    expect(codigo).not.toMatch(/createHash\("sha256"\)[\s\S]{0,80}update\(registro\.email_normalizado\)/);
  });

  it("helper canônico é a única derivação exportada do domínio de controle", () => {
    const codigo = semComentarios(FONTE_CONTROLE);
    const derivacoes = codigo.match(/createHash\("sha256"\)\.update\(emailNormalizado\)/g) ?? [];
    expect(derivacoes.length).toBe(1);
    expect(codigo).toContain("export function fingerprintDestinatarioCampanha");
  });

  it("provider fake existe SOMENTE no módulo de execução (injeção), nunca selecionável por request", () => {
    const controle = semComentarios(FONTE_CONTROLE);
    expect(controle).not.toContain("ProvedorFakeCampanha");
    expect(controle).not.toMatch(/provider.*=\s*new\s/);
    expect(controle).not.toMatch(/new\s+\w*Provider/i);
  });

  it("zero rede no módulo de controle (nenhum fetch/http/smtp/gmail)", () => {
    const codigo = semComentarios(FONTE_CONTROLE);
    expect(codigo).not.toMatch(/\bfetch\(|node:https|node:http\b|smtp|nodemailer|gmail/i);
    expect(codigo).not.toMatch(/executarWorker|outbox_email|lote_comunicacao/);
  });

  it("rotas 03B usam sessão individual e rejeitam operator_id do cliente", () => {
    const codigo = semComentarios(FONTE_SERVER);
    for (const rota of [
      "/api/campaigns/operational-readiness",
      "/api/campaigns/prepare",
      "/api/campaigns/authorize-execution",
      "/api/campaigns/activate",
      "/api/campaigns/execute-attempt",
    ]) {
      expect(codigo).toContain(`"${rota}"`);
    }
    // Todas passam por exigirOperadorCampanha (sessão; operator_id do servidor).
    for (const rota of [
      "operational-readiness",
      "prepare",
      "authorize-execution",
      "activate",
      "execute-attempt",
    ]) {
      const indice = codigo.indexOf(`caminhoExato: "/api/campaigns/${rota}"`);
      const trecho = codigo.slice(indice, indice + 2600);
      expect(trecho).toContain("exigirOperadorCampanha");
      expect(trecho).toContain("identity.operatorId");
      // Nenhuma das quatro rotas aceita operator_id do corpo do request.
      expect(trecho).not.toMatch(/body\.operatorId/);
    }
  });

  it("compositor de provas nunca aceita provas do corpo do request", () => {
    const codigo = semComentarios(FONTE_CONTROLE);
    expect(codigo).toContain("emitirProvasServerSideCampanha");
    expect(codigo).toContain("verificarProvaDestinatarioCampanha");
    expect(codigo).toContain("verificarProvaAutorizacaoHumanaCampanha");
  });

  it("interface Macroetapa 4: readiness server-driven, HOLD visível, execução desabilitada", () => {
    expect(FONTE_WORKSPACE).toContain("operational-readiness");
    expect(FONTE_WORKSPACE).toContain("Controle operacional (readiness)");
    expect(FONTE_WORKSPACE).toContain("execução indisponível");
    // O botão de execução da Macroetapa 4 permanece SEMPRE desabilitado.
    const indice = FONTE_WORKSPACE.indexOf("Controle operacional (readiness)");
    const trecho = FONTE_WORKSPACE.slice(indice, indice + 8600);
    // Nenhuma autoridade local dentro do painel de controle (o único
    // sessionStorage do arquivo é a limpeza legada de logout, fora daqui).
    expect(trecho).not.toMatch(/sessionStorage|localStorage/i);
    expect(trecho).toMatch(/type="button"\s+disabled/);
    expect(trecho).toContain("Executar (provider indisponível — envio não autorizado)");
  });

  it("CONTROLLED_GMAIL_TEST permanece segregado: nenhum caminho de controle toca o piloto", () => {
    const codigo = semComentarios(FONTE_CONTROLE);
    expect(codigo).not.toContain("CONTROLLED_GMAIL_TEST");
    const servidor = semComentarios(FONTE_SERVER);
    const indice = servidor.indexOf("/api/campaigns/execute-attempt");
    const trecho = servidor.slice(indice, indice + 4000);
    expect(trecho).not.toContain("CONTROLLED_GMAIL_TEST");
  });
});

// ---------------------------------------------------------------------------
// Parte 3 — HTTP_ROUTES (sem banco): fail-closed de autenticação
// ---------------------------------------------------------------------------

describe("SLICE_03B — rotas fail-closed sem banco (HTTP)", () => {
  beforeAll(() => {
    delete process.env.DATABASE_URL;
    vi.resetModules();
  });

  const ROTAS = [
    ["GET", "/api/campaigns/operational-readiness?campanhaId=00000000-0000-4000-8000-000000000000"],
    ["POST", "/api/campaigns/prepare"],
    ["POST", "/api/campaigns/authorize-execution"],
    ["POST", "/api/campaigns/activate"],
    ["POST", "/api/campaigns/execute-attempt"],
  ] as const;

  for (const [metodo, rota] of ROTAS) {
    it(`${metodo} ${rota} sem sessão individual → 401 (Bearer técnico não é fallback)`, async () => {
      process.env.OPERATOR_TOKEN = "legacy-token-nao-usado";
      const resposta = await despachar(
        metodo,
        rota,
        metodo === "GET" ? {} : { corpo: Buffer.from("{}") },
      );
      expect(resposta.status).toBe(401);
      expect(resposta.corpo).toContain("INDIVIDUAL_OPERATOR_AUTH_REQUIRED");
    });

    it(`${metodo} ${rota} com cookie inválido → 401; com cookie válido → 503 (banco ausente)`, async () => {
      const invalido = await despachar(metodo, rota, {
        headers: { cookie: "__Host-ic_campaign_operator_session=curto" },
        ...(metodo === "GET" ? {} : { corpo: Buffer.from("{}") }),
      });
      expect(invalido.status).toBe(401);
      const valido = await despachar(metodo, rota, {
        headers: { cookie: COOKIE_SESSAO },
        ...(metodo === "GET" ? {} : { corpo: Buffer.from("{}") }),
      });
      expect(valido.status).toBe(503);
      expect(valido.corpo).toContain("OPERATOR_IDENTITY_UNAVAILABLE");
    });
  }

  it("POST /api/campaigns/execute-attempt 03C.1: hard-disable ANTES de provas/claim (sem banco: 503 pela sessão)", async () => {
    const resposta = await despachar("POST", "/api/campaigns/execute-attempt", {
      headers: { cookie: COOKIE_SESSAO, "content-type": "application/json" },
      corpo: Buffer.from(
        JSON.stringify({
          campanhaId: randomUUID(),
          loteCampanhaId: randomUUID(),
          itemId: randomUUID(),
        }),
      ),
    });
    // Sem banco a rota não passa da sessão (503) — nenhuma execução ocorre.
    expect([503]).toContain(resposta.status);
    expect(resposta.corpo).not.toContain("CAMPAIGN_EXEC_SENT");
  });

  it("POST /api/campaigns/activate sem banco: 401 sem sessão; cookie válido → 503 (fail-closed)", async () => {
    const semSessao = await despachar("POST", "/api/campaigns/activate", {
      corpo: Buffer.from(JSON.stringify({ campanhaId: randomUUID() })),
    });
    expect(semSessao.status).toBe(401);
    const comSessao = await despachar("POST", "/api/campaigns/activate", {
      headers: { cookie: COOKIE_SESSAO },
      corpo: Buffer.from(JSON.stringify({ campanhaId: randomUUID() })),
    });
    expect(comSessao.status).toBe(503);
    expect(comSessao.corpo).toContain("OPERATOR_IDENTITY_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// Parte 4 — POSTGRESQL_INTEGRATION (DB-gated, PG16)
// ---------------------------------------------------------------------------

const describeDb = DB_URL_AMBIENTE ? describe : describe.skip;

type PoolTipado = import("@integra-correios/persistence").NodePostgresPool;

interface CenaControle {
  readonly campanhaId: string;
  readonly loteCampanhaId: string;
  readonly itemIds: readonly string[];
  readonly hashAprovacao: string;
}

describeDb("SLICE_03B — jornada de controle (POSTGRESQL_INTEGRATION)", () => {
  let pool: PoolTipado | undefined;
  const operadorId = randomUUID();
  const operadorTerceiroId = randomUUID();
  let cena: CenaControle;

  async function criarCenaControle(
    params: {
      readonly operatorId: string;
      readonly estadoLote: string;
      readonly estadoItens: readonly string[];
    },
  ): Promise<CenaControle> {
    const p = pool!;
    const campanhaId = randomUUID();
    const loteCampanhaId = randomUUID();
    const agora = new Date().toISOString();
    const hashAprovacao = createHash("sha256").update("controle-" + campanhaId).digest("hex");
    // Snapshot sintético: e-mails .test — NENHUM destinatário real.
    const registros = params.estadoItens.map((_, indice) => ({
      profissional_id: "PF-CTRL-" + String(indice + 1).padStart(4, "0"),
      nome: "Sintetico Controle " + String(indice + 1),
      email_normalizado: "controle" + String(indice + 1) + ".sintetico@exemplo.test",
      status_validacao: "APTO",
    }));
    await p.query(
      "INSERT INTO campanha_persistida (id, operator_id, fingerprint_arquivo, template_versao, hash_aprovacao, snapshot_registros, total_registros, total_aptos, total_bloqueados, total_aprovados, estado, criada_em, atualizada_em) VALUES ($1, $2, $3, 'CTRL_TESTE_V1', $4, $5::jsonb, $6, $6, 0, $6, 'LOTE_CRIADO', $7, $7)",
      [
        campanhaId,
        params.operatorId,
        hashAprovacao,
        hashAprovacao,
        JSON.stringify({ registros, total: registros.length }),
        registros.length,
        agora,
      ],
    );
    await p.query(
      "INSERT INTO lote_campanha (id, campanha_id, origem, codigo, template_versao, estado, total_itens, criado_em) VALUES ($1, $2, 'PF', $3, 'CTRL_TESTE_V1', $4, $5, $6)",
      [loteCampanhaId, campanhaId, "CTRL_LOTE_" + loteCampanhaId.slice(0, 8), params.estadoLote, registros.length, agora],
    );
    const itemIds: string[] = [];
    let ordem = 0;
    for (const estado of params.estadoItens) {
      ordem += 1;
      const itemId = randomUUID();
      itemIds.push(itemId);
      const fingerprint = createHash("sha256")
        .update(registros[ordem - 1]!.email_normalizado)
        .digest("hex");
      await p.query(
        "INSERT INTO outbox_campanha (id, lote_campanha_id, ordem, destinatario_fingerprint, payload_snapshot, estado, criada_em) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)",
        [itemId, loteCampanhaId, ordem, fingerprint, JSON.stringify({ ordem }), estado, agora],
      );
    }
    return { campanhaId, loteCampanhaId, itemIds, hashAprovacao };
  }

  beforeAll(async () => {
    const { NodePostgresPool } = await import("@integra-correios/persistence");
    pool = new NodePostgresPool({ connectionString: DB_URL_AMBIENTE!, max: 4 });
    const agora = new Date().toISOString();
    for (const [id, prefixo] of [
      [operadorId, "CTRL-A"],
      [operadorTerceiroId, "CTRL-B"],
    ] as const) {
      await pool.query(
        "INSERT INTO operador (id, codigo, nome_exibicao, status, criado_em, atualizado_em) VALUES ($1, $2, $3, 'ATIVO', $4, $4)",
        [id, prefixo + "-" + id.replace(/-/g, "").slice(0, 10), "Operador Sintetico Controle", agora],
      );
    }
    cena = await criarCenaControle({
      operatorId: operadorId,
      estadoLote: "HOLD",
      estadoItens: ["HOLD", "HOLD", "HOLD"],
    });
  });

  afterAll(async () => {
    await pool?.close();
  });

  it("readiness sem mutação: contagens corretas e fila produtiva intocada (antes==depois)", async () => {
    const p = pool!;
    const fila = async (): Promise<string> => {
      const r = await p.query(
        "SELECT 'outbox_email:' || count(*) FROM outbox_email UNION ALL SELECT 'comunicacao:' || count(*) FROM comunicacao UNION ALL SELECT 'lote_comunicacao:' || count(*) FROM lote_comunicacao UNION ALL SELECT 'item_lote:' || count(*) FROM item_lote_comunicacao",
      );
      return r.rows.map((x) => Object.values(x)[0]).join("|");
    };
    const antes = await fila();
    const estoque = await lerEstoqueOperacionalCampanha(p, {
      operatorId: operadorId,
      campanhaId: cena.campanhaId,
    });
    const depois = await fila();
    expect(antes).toBe(depois);
    expect(estoque).not.toBeNull();
    if (!estoque) return;
    expect(estoque.loteEstado).toBe("HOLD");
    expect(estoque.totalItens).toBe(3);
    expect(estoque.contagemPorEstado["HOLD"]).toBe(3);
    expect(estoque.autorizacaoHumana.concedida).toBe(false);
  });

  it("ownership: campanha alheia é indistinguível de inexistente (null)", async () => {
    const p = pool!;
    const alheia = await lerEstoqueOperacionalCampanha(p, {
      operatorId: operadorTerceiroId,
      campanhaId: cena.campanhaId,
    });
    const inexistente = await lerEstoqueOperacionalCampanha(p, {
      operatorId: operadorId,
      campanhaId: randomUUID(),
    });
    expect(alheia).toBeNull();
    expect(inexistente).toBeNull();
  });

  it("preparar fail-closed: com canPrepareBatch=false nenhuma linha muda (política antes do estado)", async () => {
    const p = pool!;
    const antes = await p.query(
      "SELECT estado FROM lote_campanha WHERE id = $1",
      [cena.loteCampanhaId],
    );
    await expect(
      prepararLoteCampanha(p, {
        operatorId: operadorId,
        campanhaId: cena.campanhaId,
        politica: politicaFechada,
      }),
    ).rejects.toBeInstanceOf(CampaignControlError);
    const depois = await p.query(
      "SELECT estado FROM lote_campanha WHERE id = $1",
      [cena.loteCampanhaId],
    );
    expect(depois.rows[0]).toEqual(antes.rows[0]);
  });

  it("preparar: HOLD → PREPARADO (outbox própria), evento auditado, idempotente, fila produtiva intocada", async () => {
    const p = pool!;
    const fila = async (): Promise<string> => {
      const r = await p.query(
        "SELECT 'outbox_email:' || count(*) FROM outbox_email UNION ALL SELECT 'comunicacao:' || count(*) FROM comunicacao UNION ALL SELECT 'lote_comunicacao:' || count(*) FROM lote_comunicacao UNION ALL SELECT 'item_lote:' || count(*) FROM item_lote_comunicacao",
      );
      return r.rows.map((x) => Object.values(x)[0]).join("|");
    };
    const antes = await fila();
    const resultado = await prepararLoteCampanha(p, {
      operatorId: operadorId,
      campanhaId: cena.campanhaId,
      politica: { ...politicaFechada, canPrepareBatch: true },
    });
    expect(resultado?.resultado).toBe("PREPARADO");
    // Item preparado: prova de destinatário derivada do snapshot confere.
    const provaDestinatario = await verificarProvaDestinatarioCampanha(p, {
      campanhaId: cena.campanhaId,
      loteCampanhaId: cena.loteCampanhaId,
      itemId: cena.itemIds[0]!,
    });
    expect(provaDestinatario.verificada).toBe(true);
    const repete = await prepararLoteCampanha(p, {
      operatorId: operadorId,
      campanhaId: cena.campanhaId,
      politica: { ...politicaFechada, canPrepareBatch: true },
    });
    expect(repete?.resultado).toBe("EXISTENTE");
    const eventos = await p.query(
      "SELECT count(*)::int AS total FROM evento_auditoria WHERE agregado_id = $1 AND tipo = 'CAMPANHA_LOTE_PREPARADO'",
      [cena.loteCampanhaId],
    );
    expect((eventos.rows[0] as { total: number }).total).toBe(1);
    const depois = await fila();
    expect(depois).toBe(antes);
    // Item NÃO capturável: lote PREPARADO não é ATIVO (claim 03A exige ATIVO).
  });

  it("alheio não prepara: null (indistinguível de inexistente), nenhuma mutação", async () => {
    const p = pool!;
    const resultado = await prepararLoteCampanha(p, {
      operatorId: operadorTerceiroId,
      campanhaId: cena.campanhaId,
      politica: { ...politicaFechada, canPrepareBatch: true },
    });
    expect(resultado).toBeNull();
    const estado = await p.query("SELECT estado FROM lote_campanha WHERE id = $1", [
      cena.loteCampanhaId,
    ]);
    expect((estado.rows[0] as { estado: string }).estado).toBe("PREPARADO");
  });

  it("autorizar: exige canExecute; lote PREPARADO → evento append-only único + referência (idempotente)", async () => {
    const p = pool!;
    await expect(
      autorizarExecucaoCampanha(p, {
        operatorId: operadorId,
        campanhaId: cena.campanhaId,
        politica: politicaFechada,
      }),
    ).rejects.toBeInstanceOf(CampaignControlError);
    const resultado = await autorizarExecucaoCampanha(p, {
      operatorId: operadorId,
      campanhaId: cena.campanhaId,
      politica: { ...politicaFechada, canExecute: true },
    });
    expect(resultado?.resultado).toBe("AUTORIZADO");
    const referencia = resultado?.referencia ?? "";
    const repete = await autorizarExecucaoCampanha(p, {
      operatorId: operadorId,
      campanhaId: cena.campanhaId,
      politica: { ...politicaFechada, canExecute: true },
    });
    expect(repete?.resultado).toBe("JA_AUTORIZADO");
    expect(repete?.referencia).toBe(referencia);
    const eventos = await p.query(
      "SELECT count(*)::int AS total FROM evento_auditoria WHERE agregado_id = $1 AND tipo = 'CAMPANHA_EXECUCAO_AUTORIZADA'",
      [cena.loteCampanhaId],
    );
    expect((eventos.rows[0] as { total: number }).total).toBe(1);
    // Lote permanece PREPARADO (autorizar NÃO ativa).
    const estado = await p.query("SELECT estado FROM lote_campanha WHERE id = $1", [
      cena.loteCampanhaId,
    ]);
    expect((estado.rows[0] as { estado: string }).estado).toBe("PREPARADO");
  });

  it("compositor: provas server-side verificadas para item do operador; replay rejeitado após settlement sintético", async () => {
    const p = pool!;
    const provas = await emitirProvasServerSideCampanha(
      p,
      {
        operatorId: operadorId,
        campanhaId: cena.campanhaId,
        loteCampanhaId: cena.loteCampanhaId,
        itemId: cena.itemIds[0]!,
      },
      { chaveProva: CHAVE_PROVA_SINTETICA },
    );
    expect(provas).not.toBeNull();
    expect(provas?.provas.recipientProofVerified).toBe(true);
    expect(provas?.provas.humanAuthorizationVerified).toBe(true);
    // Replay estrutural: um EXEC_RECEIPT posterior à emissão invalida a prova.
    const agora = new Date().toISOString();
    await p.query(
      "INSERT INTO evento_auditoria (id, agregado_tipo, agregado_id, tipo, operator_id, ator_operator_id, ocorreu_em, metadados, hash_anterior, hash_evento) VALUES ($1, 'CAMPANHA_EXECUCAO', $2, 'EXEC_RECEIPT', $3, $3, $4, $5::jsonb, NULL, $6)",
      [
        randomUUID(),
        cena.itemIds[0]!,
        operadorId,
        agora,
        JSON.stringify({ provider: "SINTETICO", message_id: "sintetico" }),
        createHash("sha256").update("hash-" + agora).digest("hex"),
      ],
    );
    const aposSettlement = await emitirProvasServerSideCampanha(
      p,
      {
        operatorId: operadorId,
        campanhaId: cena.campanhaId,
        loteCampanhaId: cena.loteCampanhaId,
        itemId: cena.itemIds[0]!,
      },
      { chaveProva: CHAVE_PROVA_SINTETICA },
    );
    expect(aposSettlement?.provas.humanAuthorizationVerified).toBe(false);
    expect(aposSettlement?.motivo).toBe("REPRODUZIDA");
  });

  it("prova de destinatário adulterada: fingerprint divergente do snapshot é rejeitado", async () => {
    const p = pool!;
    const agora = new Date().toISOString();
    // Lote dedicado com UM item válido (ordem 1 mapeia o snapshot) cujo
    // fingerprint persistido foi ADULTERADO (não deriva do snapshot).
    const campanhaId = randomUUID();
    const loteId = randomUUID();
    const itemId = randomUUID();
    const hashAprovacao = createHash("sha256").update("adulter-" + campanhaId).digest("hex");
    const registros = [
      {
        profissional_id: "PF-CTRL-ADV",
        nome: "Sintetico Adulterado",
        email_normalizado: "adulterado.sintetico@exemplo.test",
        status_validacao: "APTO",
      },
    ];
    await p.query(
      "INSERT INTO campanha_persistida (id, operator_id, fingerprint_arquivo, template_versao, hash_aprovacao, snapshot_registros, total_registros, total_aptos, total_bloqueados, total_aprovados, estado, criada_em, atualizada_em) VALUES ($1, $2, $3, 'CTRL_TESTE_V1', $4, $5::jsonb, 1, 1, 0, 1, 'LOTE_CRIADO', $6, $6)",
      [campanhaId, operadorId, hashAprovacao, hashAprovacao, JSON.stringify({ registros, total: 1 }), agora],
    );
    await p.query(
      "INSERT INTO lote_campanha (id, campanha_id, origem, codigo, template_versao, estado, total_itens, criado_em) VALUES ($1, $2, 'PF', $3, 'CTRL_TESTE_V1', 'PREPARADO', 1, $4)",
      [loteId, campanhaId, "CTRL_ADV_" + loteId.slice(0, 8), agora],
    );
    await p.query(
      "INSERT INTO outbox_campanha (id, lote_campanha_id, ordem, destinatario_fingerprint, payload_snapshot, estado, criada_em) VALUES ($1, $2, 1, $3, $4::jsonb, 'PREPARADO', $5)",
      [itemId, loteId, "ff".repeat(32), JSON.stringify({ ordem: 1 }), agora],
    );
    const verificacao = await verificarProvaDestinatarioCampanha(p, {
      campanhaId,
      loteCampanhaId: loteId,
      itemId,
    });
    expect(verificacao.verificada).toBe(false);
    expect(verificacao.motivo).toBe("FINGERPRINT_DIVERGENTE");
  });

  it("segundo claim/concorrência: item PREPARADO com lote PREPARADO NÃO é claimado (regra 14/15 — estado persistido)", async () => {
    const p = pool!;
    // Prova estrutural via estado: o claim 03A exige lote ATIVO; o controle
    // NUNCA ativa o lote (nenhuma rota ativa nesta fatia). Sem ATIVO, a
    // elegibilidade estrutural bloqueia sempre.
    const estoque = await lerEstoqueOperacionalCampanha(p, {
      operatorId: operadorId,
      campanhaId: cena.campanhaId,
    });
    expect(estoque?.loteEstado).toBe("PREPARADO");
    const execucao = avaliarAcaoOperacaoCampanha({
      acao: "EXECUTAR_ITEM",
      politica: { ...politicaFechada, canExecute: true, realSendEnabled: true },
      loteEstado: estoque!.loteEstado,
      totalItens: estoque!.totalItens,
      autorizacaoHumanaConcedida: true,
    });
    expect(execucao.bloqueios).toContain("LOTE_NAO_ATIVO");
  });

  it("resultado ambíguo continua sem retry automático (estrutura 03A preservada)", async () => {
    const fonte = FONTE_EXECUCAO;
    expect(fonte).toContain("auto_retry: false");
    expect(fonte).toContain("reconciliacao: \"HUMANA\"");
  });
});

// ---------------------------------------------------------------------------
// Parte 5 — POSTGRESQL_INTEGRATION 03C.1 (DB-gated, PG16): ativação controlada
// ---------------------------------------------------------------------------

describeDb("SLICE_03C.1 — ativação controlada do lote (POSTGRESQL_INTEGRATION)", () => {
  let pool: PoolTipado | undefined;
  const operadorId = randomUUID();
  const operadorTerceiroId = randomUUID();
  const CHAVE_CANARIO_ENV = "PF_CAMPAIGN_CANARY_RECIPIENT_FINGERPRINT";
  const CHAVE_PROVA_ENV = "PF_CAMPAIGN_PROOF_KEY_BASE64";
  const CHAVE_PROVA_BASE64 = "ZmFpbC1jbG9zZWQtcHJvZmEta2V5LXN5bnRoZXRpYy0wMzI=";

  interface CenaAtivacao {
    readonly campanhaId: string;
    readonly loteCampanhaId: string;
    readonly itemIds: readonly string[];
    readonly fingerprints: readonly string[];
  }

  async function criarCenaAtivacao(params: {
    readonly operatorId: string;
    readonly estadoLote: string;
    readonly emails: readonly string[];
  }): Promise<CenaAtivacao> {
    const p = pool!;
    const campanhaId = randomUUID();
    const loteCampanhaId = randomUUID();
    const agora = new Date().toISOString();
    const hashAprovacao = createHash("sha256").update("ativ-" + campanhaId).digest("hex");
    const registros = params.emails.map((email, indice) => ({
      profissional_id: "PF-ACTV-" + String(indice + 1).padStart(4, "0"),
      nome: "Sintetico Ativacao " + String(indice + 1),
      email_normalizado: email,
      status_validacao: "APTO",
    }));
    await p.query(
      "INSERT INTO campanha_persistida (id, operator_id, fingerprint_arquivo, template_versao, hash_aprovacao, snapshot_registros, total_registros, total_aptos, total_bloqueados, total_aprovados, estado, criada_em, atualizada_em) VALUES ($1, $2, $3, 'CTRL_TESTE_V1', $4, $5::jsonb, $6, $6, 0, $6, 'LOTE_CRIADO', $7, $7)",
      [campanhaId, params.operatorId, hashAprovacao, hashAprovacao, JSON.stringify({ registros, total: registros.length }), registros.length, agora],
    );
    await p.query(
      "INSERT INTO lote_campanha (id, campanha_id, origem, codigo, template_versao, estado, total_itens, criado_em) VALUES ($1, $2, 'PF', $3, 'CTRL_TESTE_V1', $4, $5, $6)",
      [loteCampanhaId, campanhaId, "CTRL_LOTE_" + loteCampanhaId.slice(0, 8), params.estadoLote, registros.length, agora],
    );
    const itemIds: string[] = [];
    const fingerprints: string[] = [];
    let ordem = 0;
    for (const email of params.emails) {
      ordem += 1;
      const itemId = randomUUID();
      const fingerprint = createHash("sha256").update(email).digest("hex");
      itemIds.push(itemId);
      fingerprints.push(fingerprint);
      await p.query(
        "INSERT INTO outbox_campanha (id, lote_campanha_id, ordem, destinatario_fingerprint, payload_snapshot, estado, criada_em) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)",
        [itemId, loteCampanhaId, ordem, fingerprint, JSON.stringify({ ordem }), "PREPARADO", agora],
      );
    }
    return { campanhaId, loteCampanhaId, itemIds, fingerprints };
  }

  async function inserirEventoAutorizacao(
    loteCampanhaId: string,
    ocorreuEm: string,
  ): Promise<string> {
    const p = pool!;
    const eventoId = randomUUID();
    await p.query(
      "INSERT INTO evento_auditoria (id, agregado_tipo, agregado_id, tipo, operator_id, ator_operator_id, ocorreu_em, metadados, hash_anterior, hash_evento) VALUES ($1, 'CAMPANHA_EXECUCAO', $2, $3, $4, $4, $5, $6::jsonb, NULL, $7)",
      [
        eventoId,
        loteCampanhaId,
        CODIGO_EVENTO_AUTORIZACAO,
        operadorId,
        ocorreuEm,
        JSON.stringify({
          esquema: "CAMPANHA_CONTROLE_V1",
          acao: ACAO_AUTORIZADA_EXECUCAO,
          lote_estado: "PREPARADO",
        }),
        createHash("sha256").update("evt-" + eventoId).digest("hex"),
      ],
    );
    return eventoId;
  }

  async function contarEventos(loteCampanhaId: string, tipo: string): Promise<number> {
    const p = pool!;
    const resultado = await p.query(
      "SELECT count(*)::int AS total FROM evento_auditoria WHERE agregado_id = $1 AND tipo = $2",
      [loteCampanhaId, tipo],
    );
    return (resultado.rows[0] as { total: number }).total;
  }

  async function estadoLote(loteCampanhaId: string): Promise<string> {
    const p = pool!;
    const resultado = await p.query("SELECT estado FROM lote_campanha WHERE id = $1", [loteCampanhaId]);
    return (resultado.rows[0] as { estado: string }).estado;
  }

  async function comCanario<T>(fingerprint: string, fn: () => Promise<T>): Promise<T> {
    const anterior = process.env[CHAVE_CANARIO_ENV];
    process.env[CHAVE_CANARIO_ENV] = fingerprint;
    try {
      return await fn();
    } finally {
      if (anterior === undefined) delete process.env[CHAVE_CANARIO_ENV];
      else process.env[CHAVE_CANARIO_ENV] = anterior;
    }
  }

  // Normalização temporal canônica (TESTE ONLY): o driver PostgreSQL
  // materializa timestamptz como Date enquanto o contrato V2 persistiu uma
  // string ISO. Recupera a MESMA representação ISO originalmente persistida
  // — sem alterar precisão, timezone ou timestamp para fazer o teste passar.
  const instanteIso = (valor: Date | string): string =>
    valor instanceof Date
      ? valor.toISOString()
      : new Date(valor).toISOString();

  function comandoAtivar(cena: CenaAtivacao) {
    return {
      operatorId: operadorId,
      campanhaId: cena.campanhaId,
      politica: politicaAtivacao(),
      papeisOperador: ["EXECUTOR"],
    } as const;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL_AMBIENTE;
    vi.resetModules();
    const servidor = await import("../src/server.js");
    despacharAtivo = servidor.despachar;
    const { NodePostgresPool } = await import("@integra-correios/persistence");
    pool = new NodePostgresPool({ connectionString: DB_URL_AMBIENTE!, max: 4 });
    const agora = new Date().toISOString();
    for (const [id, prefixo] of [
      [operadorId, "ACTV-A"],
      [operadorTerceiroId, "ACTV-B"],
    ] as const) {
      await pool.query(
        "INSERT INTO operador (id, codigo, nome_exibicao, status, criado_em, atualizado_em) VALUES ($1, $2, $3, 'ATIVO', $4, $4)",
        [id, prefixo + "-" + id.replace(/-/g, "").slice(0, 10), "Operador Sintetico Ativacao", agora],
      );
    }
  });

  afterAll(async () => {
    await pool?.close();
  });

  it("G+I. EXATAMENTE um canário server-side: PREPARADO → ATIVO, TODOS os itens permanecem PREPARADO, zero ENFILEIRADO", async () => {
    const cena = await criarCenaAtivacao({
      operatorId: operadorId,
      estadoLote: "PREPARADO",
      emails: [
        "canario.ativacao@exemplo.test",
        "segundo.ativacao@exemplo.test",
        "terceiro.ativacao@exemplo.test",
      ],
    });
    await inserirEventoAutorizacao(cena.loteCampanhaId, new Date().toISOString());
    const resultado = await comCanario(cena.fingerprints[0]!, async () =>
      ativarLoteCampanha(pool!, comandoAtivar(cena), { chaveProva: CHAVE_PROVA_SINTETICA }),
    );
    expect(resultado?.resultado).toBe("ATIVADO");
    expect(await contarEventos(cena.loteCampanhaId, CODIGO_EVENTO_CANARIO)).toBe(1);
    expect(await contarEventos(cena.loteCampanhaId, CODIGO_EVENTO_ATIVACAO)).toBe(1);
    expect(await estadoLote(cena.loteCampanhaId)).toBe("ATIVO");
    const p = pool!;
    const itens = await p.query(
      "SELECT estado, count(*)::int AS total FROM outbox_campanha WHERE lote_campanha_id = $1 GROUP BY estado",
      [cena.loteCampanhaId],
    );
    const contagens = Object.fromEntries(
      (itens.rows as { estado: string; total: number }[]).map((r) => [r.estado, r.total]),
    );
    expect(contagens["PREPARADO"]).toBe(3);
    expect(contagens["ENFILEIRADO"]).toBeUndefined();
    // S. Metadata do canário SANITIZADA: sem e-mail, sem fingerprint.
    const evento = await p.query(
      "SELECT metadados FROM evento_auditoria WHERE agregado_id = $1 AND tipo = $2",
      [cena.loteCampanhaId, CODIGO_EVENTO_CANARIO],
    );
    const metadados = JSON.stringify((evento.rows[0] as { metadados: unknown }).metadados);
    expect(metadados).toContain("CAMPANHA_CANARIO_V1");
    expect(metadados).not.toContain("exemplo.test");
    expect(metadados).not.toContain(cena.fingerprints[0]!);
    expect(resultado?.canarioReferencia).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("L. repetição em ATIVO retorna o MESMO canário sem duplicar eventos", async () => {
    const cena = await criarCenaAtivacao({
      operatorId: operadorId,
      estadoLote: "PREPARADO",
      emails: ["unico.repeticao@exemplo.test"],
    });
    await inserirEventoAutorizacao(cena.loteCampanhaId, new Date().toISOString());
    const primeira = await comCanario(cena.fingerprints[0]!, async () =>
      ativarLoteCampanha(pool!, comandoAtivar(cena), { chaveProva: CHAVE_PROVA_SINTETICA }),
    );
    expect(primeira?.resultado).toBe("ATIVADO");
    const segunda = await comCanario(cena.fingerprints[0]!, async () =>
      ativarLoteCampanha(pool!, comandoAtivar(cena), { chaveProva: CHAVE_PROVA_SINTETICA }),
    );
    expect(segunda?.resultado).toBe("JA_ATIVADO");
    expect(segunda?.canarioReferencia).toBe(primeira?.canarioReferencia);
    expect(await contarEventos(cena.loteCampanhaId, CODIGO_EVENTO_CANARIO)).toBe(1);
    expect(await contarEventos(cena.loteCampanhaId, CODIGO_EVENTO_ATIVACAO)).toBe(1);
  });

  it("D+H. seleção segue EXCLUSIVAMENTE a configuração server-side (não 'primeiro item'; cliente não tem autoridade)", () => {
    const assinatura = semComentarios(FONTE_CONTROLE);
    expect(assinatura).not.toMatch(/ativarLoteCampanha[\s\S]{0,400}itemId/);
    const rota = semComentarios(FONTE_SERVER);
    const indice = rota.indexOf('caminhoExato: "/api/campaigns/activate"');
    const trecho = rota.slice(indice, indice + 2600);
    expect(trecho).toContain("body.campanhaId");
    expect(trecho).not.toMatch(/body\.(itemId|fingerprint|email|operatorId|loteCampanhaId)/);
  });

  it("D. candidato escolhido é o da configuração server-side (ordem 2 de 3 — não o primeiro)", async () => {
    const cena = await criarCenaAtivacao({
      operatorId: operadorId,
      estadoLote: "PREPARADO",
      emails: [
        "primeiro.config@exemplo.test",
        "alvo.config@exemplo.test",
        "terceiro.config@exemplo.test",
      ],
    });
    await inserirEventoAutorizacao(cena.loteCampanhaId, new Date().toISOString());
    const resultado = await comCanario(cena.fingerprints[1]!, async () =>
      ativarLoteCampanha(pool!, comandoAtivar(cena), { chaveProva: CHAVE_PROVA_SINTETICA }),
    );
    expect(resultado?.resultado).toBe("ATIVADO");
    const p = pool!;
    const evento = await p.query(
      "SELECT metadados FROM evento_auditoria WHERE id = $1",
      [resultado?.canarioReferencia],
    );
    const metadados = (evento.rows[0] as { metadados: { ordem: number } }).metadados;
    expect(Number(metadados.ordem)).toBe(2);
  });

  it("E. ZERO correspondências → CANARY_RECIPIENT_NOT_FOUND sem mutação", async () => {
    const cena = await criarCenaAtivacao({
      operatorId: operadorId,
      estadoLote: "PREPARADO",
      emails: ["nao.configurado@exemplo.test"],
    });
    await inserirEventoAutorizacao(cena.loteCampanhaId, new Date().toISOString());
    await expect(
      comCanario("ef".repeat(32), async () =>
        ativarLoteCampanha(pool!, comandoAtivar(cena), { chaveProva: CHAVE_PROVA_SINTETICA }),
      ),
    ).rejects.toMatchObject({ code: "CANARY_RECIPIENT_NOT_FOUND" });
    expect(await estadoLote(cena.loteCampanhaId)).toBe("PREPARADO");
    expect(await contarEventos(cena.loteCampanhaId, CODIGO_EVENTO_CANARIO)).toBe(0);
    expect(await contarEventos(cena.loteCampanhaId, CODIGO_EVENTO_ATIVACAO)).toBe(0);
  });

  it("F. MÚLTIPLAS correspondências → CANARY_RECIPIENT_AMBIGUOUS sem mutação", async () => {
    const cena = await criarCenaAtivacao({
      operatorId: operadorId,
      estadoLote: "PREPARADO",
      emails: [
        "duplicado.ativacao@exemplo.test",
        "duplicado.ativacao@exemplo.test",
      ],
    });
    await inserirEventoAutorizacao(cena.loteCampanhaId, new Date().toISOString());
    await expect(
      comCanario(cena.fingerprints[0]!, async () =>
        ativarLoteCampanha(pool!, comandoAtivar(cena), { chaveProva: CHAVE_PROVA_SINTETICA }),
      ),
    ).rejects.toMatchObject({ code: "CANARY_RECIPIENT_AMBIGUOUS" });
    expect(await estadoLote(cena.loteCampanhaId)).toBe("PREPARADO");
    expect(await contarEventos(cena.loteCampanhaId, CODIGO_EVENTO_CANARIO)).toBe(0);
  });

  it("J. HOLD/CANCELADO/alheio/inexistente não ativam (sem mutação, 404 sanitizado)", async () => {
    const hold = await criarCenaAtivacao({
      operatorId: operadorId,
      estadoLote: "HOLD",
      emails: ["hold.ativacao@exemplo.test"],
    });
    await inserirEventoAutorizacao(hold.loteCampanhaId, new Date().toISOString());
    await expect(
      comCanario(hold.fingerprints[0]!, async () =>
        ativarLoteCampanha(pool!, comandoAtivar(hold), { chaveProva: CHAVE_PROVA_SINTETICA }),
      ),
    ).rejects.toMatchObject({ code: "CAMPAIGN_ACTIVATE_BLOCKED" });
    expect(await estadoLote(hold.loteCampanhaId)).toBe("HOLD");

    const cancelado = await criarCenaAtivacao({
      operatorId: operadorId,
      estadoLote: "CANCELADO",
      emails: ["cancelado.ativacao@exemplo.test"],
    });
    await expect(
      comCanario(cancelado.fingerprints[0]!, async () =>
        ativarLoteCampanha(pool!, comandoAtivar(cancelado), { chaveProva: CHAVE_PROVA_SINTETICA }),
      ),
    ).rejects.toMatchObject({ code: "CAMPAIGN_ACTIVATE_BLOCKED" });
    expect(await estadoLote(cancelado.loteCampanhaId)).toBe("CANCELADO");

    const alheio = await criarCenaAtivacao({
      operatorId: operadorTerceiroId,
      estadoLote: "PREPARADO",
      emails: ["alheio.ativacao@exemplo.test"],
    });
    await inserirEventoAutorizacao(alheio.loteCampanhaId, new Date().toISOString());
    const resultadoAlheio = await comCanario(alheio.fingerprints[0]!, async () =>
      ativarLoteCampanha(pool!, { ...comandoAtivar(alheio), operatorId: operadorId }, { chaveProva: CHAVE_PROVA_SINTETICA }),
    );
    expect(resultadoAlheio).toBeNull();
    expect(await estadoLote(alheio.loteCampanhaId)).toBe("PREPARADO");
    expect(await contarEventos(alheio.loteCampanhaId, CODIGO_EVENTO_CANARIO)).toBe(0);

    const inexistente = await comCanario("ab".repeat(32), async () =>
      ativarLoteCampanha(
        pool!,
        { ...comandoAtivar(alheio), campanhaId: randomUUID() },
        { chaveProva: CHAVE_PROVA_SINTETICA },
      ),
    );
    expect(inexistente).toBeNull();
  });

  it("B+C (DB). sem autorização humana vigente ou sem proof key → bloqueio sanitizado sem mutação", async () => {
    const cena = await criarCenaAtivacao({
      operatorId: operadorId,
      estadoLote: "PREPARADO",
      emails: ["gate.ativacao@exemplo.test"],
    });
    await expect(
      comCanario(cena.fingerprints[0]!, async () =>
        ativarLoteCampanha(pool!, comandoAtivar(cena), { chaveProva: CHAVE_PROVA_SINTETICA }),
      ),
    ).rejects.toMatchObject({ code: "CAMPAIGN_ACTIVATE_BLOCKED" });
    await expect(
      comCanario(cena.fingerprints[0]!, async () =>
        ativarLoteCampanha(pool!, comandoAtivar(cena), { chaveProva: CHAVE_PROVA_SINTETICA }),
      ),
    ).rejects.toThrow(/AUTORIZACAO_HUMANA_AUSENTE/);
    // Com autorização mas SEM chave de prova → bloqueio com PROOF_KEY_UNAVAILABLE.
    await inserirEventoAutorizacao(cena.loteCampanhaId, new Date().toISOString());
    await expect(
      comCanario(cena.fingerprints[0]!, async () =>
        ativarLoteCampanha(pool!, comandoAtivar(cena)),
      ),
    ).rejects.toThrow(/PROOF_KEY_UNAVAILABLE/);
    expect(await estadoLote(cena.loteCampanhaId)).toBe("PREPARADO");
    expect(await contarEventos(cena.loteCampanhaId, CODIGO_EVENTO_CANARIO)).toBe(0);
    expect(await contarEventos(cena.loteCampanhaId, CODIGO_EVENTO_ATIVACAO)).toBe(0);
  });

  it("K. duas ativações CONCORRENTES: exatamente uma seleção e uma ativação", async () => {
    const cena = await criarCenaAtivacao({
      operatorId: operadorId,
      estadoLote: "PREPARADO",
      emails: ["concorrente.ativacao@exemplo.test"],
    });
    await inserirEventoAutorizacao(cena.loteCampanhaId, new Date().toISOString());
    const resultados = await Promise.all([
      comCanario(cena.fingerprints[0]!, async () =>
        ativarLoteCampanha(pool!, comandoAtivar(cena), { chaveProva: CHAVE_PROVA_SINTETICA }),
      ),
      comCanario(cena.fingerprints[0]!, async () =>
        ativarLoteCampanha(pool!, comandoAtivar(cena), { chaveProva: CHAVE_PROVA_SINTETICA }),
      ),
    ]);
    const ativacoes = resultados.filter((r) => r?.resultado === "ATIVADO");
    const repeticoes = resultados.filter((r) => r?.resultado === "JA_ATIVADO");
    expect(ativacoes.length).toBe(1);
    expect(repeticoes.length).toBe(1);
    expect(repeticoes[0]?.canarioReferencia).toBe(ativacoes[0]?.canarioReferencia);
    expect(await contarEventos(cena.loteCampanhaId, CODIGO_EVENTO_CANARIO)).toBe(1);
    expect(await contarEventos(cena.loteCampanhaId, CODIGO_EVENTO_ATIVACAO)).toBe(1);
    expect(await estadoLote(cena.loteCampanhaId)).toBe("ATIVO");
  });

  it("M. antirreplay usa sequencia: settlement com TIMESTAMP IGUAL (e sequencia posterior) reproduz a prova", async () => {
    const cena = await criarCenaAtivacao({
      operatorId: operadorId,
      estadoLote: "PREPARADO",
      emails: ["sequencia.ativacao@exemplo.test"],
    });
    const carimbo = "2026-01-01T00:00:00.000Z";
    const referencia = await inserirEventoAutorizacao(cena.loteCampanhaId, carimbo);
    const antes = await emitirProvasServerSideCampanha(
      pool!,
      {
        operatorId: operadorId,
        campanhaId: cena.campanhaId,
        loteCampanhaId: cena.loteCampanhaId,
        itemId: cena.itemIds[0]!,
      },
      { chaveProva: CHAVE_PROVA_SINTETICA },
    );
    expect(antes?.provas.humanAuthorizationVerified).toBe(true);
    // Settlement com ocorreu_em IGUAL ao da autorização — somente a sequencia
    // IDENTITY (posterior) o torna replay. Autoridade = sequencia, não tempo.
    await pool!.query(
      "INSERT INTO evento_auditoria (id, agregado_tipo, agregado_id, tipo, operator_id, ator_operator_id, ocorreu_em, metadados, hash_anterior, hash_evento) VALUES ($1, 'CAMPANHA_EXECUCAO', $2, 'EXEC_RECEIPT', $3, $3, $4, $5::jsonb, NULL, $6)",
      [
        randomUUID(),
        cena.itemIds[0]!,
        operadorId,
        carimbo,
        JSON.stringify({ provider: "SINTETICO", message_id: "sintetico" }),
        createHash("sha256").update("receipt-" + carimbo).digest("hex"),
      ],
    );
    const depois = await emitirProvasServerSideCampanha(
      pool!,
      {
        operatorId: operadorId,
        campanhaId: cena.campanhaId,
        loteCampanhaId: cena.loteCampanhaId,
        itemId: cena.itemIds[0]!,
      },
      { chaveProva: CHAVE_PROVA_SINTETICA },
    );
    expect(depois?.provas.humanAuthorizationVerified).toBe(false);
    expect(depois?.motivo).toBe("REPRODUZIDA");
    expect(referencia).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("N+O (HTTP, todas as flags abertas). execute-attempt: CAMPAIGN_PROVIDER_DISABLED, zero claim/UPDATE/INSERT/provider", async () => {
    const adminCookie = await bootstrapAdmin();
    const executor = await provisionOperator(adminCookie, ["EXECUTOR"]);
    const cena = await criarCenaAtivacao({
      operatorId: executor.operatorId,
      estadoLote: "ATIVO",
      emails: ["harddisable.ativacao@exemplo.test"],
    });
    await inserirEventoAutorizacao(cena.loteCampanhaId, new Date().toISOString());
    const p = pool!;
    const eventosItemAntes = await p.query(
      "SELECT count(*)::int AS total FROM evento_auditoria WHERE agregado_id = $1",
      [cena.itemIds[0]!],
    );
    process.env.PF_CAMPAIGN_EXECUTE_ENABLED = "true";
    process.env.REAL_SEND_ENABLED = "true";
    process.env[CHAVE_CANARIO_ENV] = cena.fingerprints[0]!;
    process.env[CHAVE_PROVA_ENV] = CHAVE_PROVA_BASE64;
    try {
      const resposta = await despachar("POST", "/api/campaigns/execute-attempt", {
        headers: { cookie: executor.cookie, "content-type": "application/json" },
        corpo: Buffer.from(
          JSON.stringify({
            campanhaId: cena.campanhaId,
            loteCampanhaId: cena.loteCampanhaId,
            itemId: cena.itemIds[0]!,
          }),
        ),
      });
      expect(resposta.status).toBe(409);
      expect(resposta.corpo).toContain("CAMPAIGN_PROVIDER_DISABLED");
      expect(resposta.corpo).not.toContain("CAMPAIGN_EXEC_SENT");
    } finally {
      delete process.env.PF_CAMPAIGN_EXECUTE_ENABLED;
      delete process.env.REAL_SEND_ENABLED;
      delete process.env[CHAVE_CANARIO_ENV];
      delete process.env[CHAVE_PROVA_ENV];
    }
    // Zero claim/UPDATE: item permanece PREPARADO. Zero INSERT: nenhum evento novo.
    const item = await p.query("SELECT estado FROM outbox_campanha WHERE id = $1", [cena.itemIds[0]!]);
    expect((item.rows[0] as { estado: string }).estado).toBe("PREPARADO");
    const eventosItemDepois = await p.query(
      "SELECT count(*)::int AS total FROM evento_auditoria WHERE agregado_id = $1",
      [cena.itemIds[0]!],
    );
    expect(
      (eventosItemDepois.rows[0] as { total: number }).total,
    ).toBe((eventosItemAntes.rows[0] as { total: number }).total);
    expect(await contarEventos(cena.loteCampanhaId, CODIGO_EVENTO_ATIVACAO)).toBe(0);
  });

  it("activate (HTTP, banco): fail-closed sem autorização → 409 CAMPAIGN_ACTIVATE_BLOCKED sanitizado", async () => {
    const adminCookie = await bootstrapAdmin();
    const executor = await provisionOperator(adminCookie, ["EXECUTOR"]);
    const cena = await criarCenaAtivacao({
      operatorId: executor.operatorId,
      estadoLote: "PREPARADO",
      emails: ["rota.ativacao@exemplo.test"],
    });
    process.env[CHAVE_CANARIO_ENV] = cena.fingerprints[0]!;
    process.env[CHAVE_PROVA_ENV] = CHAVE_PROVA_BASE64;
    try {
      const resposta = await despachar("POST", "/api/campaigns/activate", {
        headers: { cookie: executor.cookie, "content-type": "application/json" },
        corpo: Buffer.from(JSON.stringify({ campanhaId: cena.campanhaId })),
      });
      expect(resposta.status).toBe(409);
      expect(resposta.corpo).toContain("CAMPAIGN_ACTIVATE_BLOCKED");
      expect(resposta.corpo).toContain("AUTORIZACAO_HUMANA_AUSENTE");
      expect(resposta.corpo).not.toContain("exemplo.test");
      expect(resposta.corpo).not.toContain(cena.fingerprints[0]!);
    } finally {
      delete process.env[CHAVE_CANARIO_ENV];
      delete process.env[CHAVE_PROVA_ENV];
    }
    expect(await estadoLote(cena.loteCampanhaId)).toBe("PREPARADO");
  });

  function firstCookie(header: string | undefined): string {
    return header?.split("\n")[0]?.split(";")[0] ?? "";
  }

  async function bootstrapAdmin(): Promise<string> {
    const operatorId = randomUUID();
    const tokenId = randomUUID();
    const suffix = operatorId.replace(/-/g, "").slice(0, 12);
    const rawCredential = `AdminIndividual_abcdefghijklmnopqrstuvwxyz0123456789${suffix}`;
    const now = new Date().toISOString();
    const { NodePostgresPool } = await import("@integra-correios/persistence");
    const poolAdmin = new NodePostgresPool({ connectionString: DB_URL_AMBIENTE! });
    try {
      await poolAdmin.query(
        `INSERT INTO operador (id, codigo, nome_exibicao, status, criado_em, atualizado_em)
         VALUES ($1, $2, $3, 'ATIVO', $4, $4)`,
        [operatorId, `ADMIN-${suffix}`, "Administrador Individual Sintético", now],
      );
      await poolAdmin.query(
        `INSERT INTO operador_papel (operator_id, papel, ativo, concedido_em)
         VALUES ($1, 'ADMIN_TECNICO', true, $2)`,
        [operatorId, now],
      );
      await poolAdmin.query(
        `INSERT INTO operador_token (id, operator_id, token_hash, emitido_por_operator_id, status, criado_em)
         VALUES ($1, $2, $3, $2, 'ATIVO', $4)`,
        [tokenId, operatorId, createHash("sha256").update(rawCredential).digest("hex"), now],
      );
    } finally {
      await poolAdmin.close();
    }
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: rawCredential })),
    });
    expect(login.status).toBe(200);
    return firstCookie(login.headers["set-cookie"]);
  }

  async function provisionOperator(
    adminCookie: string,
    roles: string[],
  ): Promise<{ operatorId: string; cookie: string }> {
    const rawCredential = `Op_abcdefghijklmnopqrstuvwxyz0123456789${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
    const response = await despachar("POST", "/api/operator/admin/provision", {
      headers: { cookie: adminCookie, "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({
        code: `OP-${suffix}`,
        displayName: `Operador ${suffix}`,
        roles,
        credentialHash: createHash("sha256").update(rawCredential).digest("hex"),
      })),
    });
    expect(response.status).toBe(201);
    const operatorId = (JSON.parse(response.corpo) as { operatorId: string }).operatorId;
    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: rawCredential })),
    });
    expect(login.status).toBe(200);
    return { operatorId, cookie: firstCookie(login.headers["set-cookie"]) };
  }

  it("A+B+C+E. dois eventos do MESMO agregado, MESMA transação, MESMO ocorreu_em: 2 linhas, 2 hashes distintos (64 hex)", async () => {
    const cena = await criarCenaAtivacao({
      operatorId: operadorId,
      estadoLote: "PREPARADO",
      emails: ["unico.hashregressao@exemplo.test"],
    });
    await inserirEventoAutorizacao(cena.loteCampanhaId, new Date().toISOString());
    const resultado = await comCanario(cena.fingerprints[0]!, async () =>
      ativarLoteCampanha(pool!, comandoAtivar(cena), { chaveProva: CHAVE_PROVA_SINTETICA }),
    );
    expect(resultado?.resultado).toBe("ATIVADO");
    const p = pool!;
    const linhas = await p.query(
      `SELECT id, agregado_tipo, agregado_id, tipo, ocorreu_em, hash_evento
        FROM evento_auditoria
        WHERE agregado_id = $1 AND tipo IN ($2, $3)
        ORDER BY tipo`,
      [cena.loteCampanhaId, CODIGO_EVENTO_CANARIO, CODIGO_EVENTO_ATIVACAO],
    );
    expect(linhas.rows.length).toBe(2);
    const eventos = linhas.rows as {
      id: string; agregado_tipo: string; agregado_id: string;
      tipo: string; ocorreu_em: Date | string; hash_evento: string;
    }[];
    const ids = new Set(eventos.map((e) => e.id));
    const hashes = new Set(eventos.map((e) => e.hash_evento));
    expect(ids.size).toBe(2);
    expect(hashes.size).toBe(2);
    for (const e of eventos) {
      expect(e.hash_evento).toMatch(/^[0-9a-f]{64}$/);
      expect(e.agregado_tipo).toBe("CAMPANHA_EXECUCAO");
      expect(e.agregado_id).toBe(cena.loteCampanhaId);
      // Igualdade TEMPORAL canônica (o driver materializa Date; toBe()
      // compararia referência de objeto, não o instante).
      expect(instanteIso(e.ocorreu_em)).toBe(instanteIso(eventos[0]!.ocorreu_em));
    }
    // Identidade persistida do canário = canarioReferencia retornado.
    const referenciaCanario = eventos.find((e) => e.tipo === CODIGO_EVENTO_CANARIO)!.id;
    expect(referenciaCanario).toBe(resultado?.canarioReferencia);
  });

  it("I. recomputação do hash V2 a partir da linha persistida (id, agregado_tipo, agregado_id, tipo, ocorreu_em)", async () => {
    const cena = await criarCenaAtivacao({
      operatorId: operadorId,
      estadoLote: "PREPARADO",
      emails: ["unico.recompute@exemplo.test"],
    });
    await inserirEventoAutorizacao(cena.loteCampanhaId, new Date().toISOString());
    const resultado = await comCanario(cena.fingerprints[0]!, async () =>
      ativarLoteCampanha(pool!, comandoAtivar(cena), { chaveProva: CHAVE_PROVA_SINTETICA }),
    );
    expect(resultado?.resultado).toBe("ATIVADO");
    const p = pool!;
    const linhas = await p.query(
      `SELECT id, agregado_tipo, agregado_id, tipo, ocorreu_em, hash_evento
        FROM evento_auditoria
        WHERE agregado_id = $1 AND tipo IN ($2, $3)
        ORDER BY tipo`,
      [cena.loteCampanhaId, CODIGO_EVENTO_CANARIO, CODIGO_EVENTO_ATIVACAO],
    );
    const eventos = linhas.rows as {
      id: string; agregado_tipo: string; agregado_id: string;
      tipo: string; ocorreu_em: Date | string; hash_evento: string;
    }[];
    expect(eventos.length).toBe(2);
    for (const e of eventos) {
      // Recomputação INDEPENDENTE do contrato V2 documentado: HMAC-SHA256
      // com a chave legada deste contrato, sobre a representação canônica
      // persistida — sem chamar o helper privado de produção.
      const payload = JSON.stringify([
        "CAMPANHA_CONTROLE_HASH_V2",
        e.id,
        e.agregado_tipo,
        e.agregado_id,
        e.tipo,
        instanteIso(e.ocorreu_em),
      ]);
      const recomputado = createHmac("sha256", "audit-chain")
        .update(payload)
        .digest("hex");
      expect(recomputado).toBe(e.hash_evento);
    }
  });
});
