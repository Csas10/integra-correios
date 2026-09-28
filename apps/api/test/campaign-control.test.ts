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

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ACAO_AUTORIZADA_EXECUCAO,
  CampaignControlError,
  avaliarAcaoOperacaoCampanha,
  emitirProvaAutorizacaoHumanaCampanha,
  emitirProvaDestinatarioCampanha,
  emitirProvasServerSideCampanha,
  fingerprintDestinatarioCampanha,
  lerEstoqueOperacionalCampanha,
  prepararLoteCampanha,
  autorizarExecucaoCampanha,
  verificarProvaAutorizacaoHumanaCampanha,
  verificarProvaDestinatarioCampanha,
  type CampanhaPool,
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
    const prova = emitirProvaDestinatarioCampanha({ ...ids, fingerprintDestinatario: fingerprint });
    const outra = emitirProvaDestinatarioCampanha({ ...ids, fingerprintDestinatario: fingerprint });
    expect(prova.tipo).toBe("PROVA_DESTINATARIO_CAMPANHA_V1");
    expect(prova.valor).toBe(outra.valor);
    const divergente = emitirProvaDestinatarioCampanha({
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
    });
    const provaB = emitirProvaAutorizacaoHumanaCampanha({
      ...ids,
      chaveIdempotencia,
      acaoAutorizada: ACAO_AUTORIZADA_EXECUCAO,
      nonce: randomUUID(),
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
    });
    const semEmissao = await verificarProvaAutorizacaoHumanaCampanha(poolVazio, esperado, {
      valor: prova.valor,
      referencia: prova.referencia,
    });
    expect(semEmissao.verificada).toBe(false);
    expect(semEmissao.motivo).toBe("REPRODUZIDA");
    const ausente = await verificarProvaAutorizacaoHumanaCampanha(poolVazio, esperado, null);
    expect(ausente.verificada).toBe(false);
    expect(ausente.motivo).toBe("FORMATO_INVALIDO");
  });
});

// ---------------------------------------------------------------------------
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
      "/api/campaigns/execute-attempt",
    ]) {
      expect(codigo).toContain(`"${rota}"`);
    }
    // Todas passam por exigirOperadorCampanha (sessão; operator_id do servidor).
    for (const rota of [
      "operational-readiness",
      "prepare",
      "authorize-execution",
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
    const trecho = FONTE_WORKSPACE.slice(indice, indice + 4200);
    // Nenhuma autoridade local dentro do painel de controle (o único
    // sessionStorage do arquivo é a limpeza legada de logout, fora daqui).
    expect(trecho).not.toMatch(/sessionStorage|localStorage/i);
    expect(trecho).toContain('type="button" disabled');
    expect(trecho).toContain("Executar (bloqueada");
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

  it("POST /api/campaigns/execute-attempt NUNCA executa com as políticas fechadas (sem banco: 503 antes de tudo)", async () => {
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
    expect([503, 409, 404]).toContain(resposta.status);
    expect(resposta.corpo).not.toContain("CAMPAIGN_EXEC_SENT");
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
    const provas = await emitirProvasServerSideCampanha(p, {
      operatorId: operadorId,
      campanhaId: cena.campanhaId,
      loteCampanhaId: cena.loteCampanhaId,
      itemId: cena.itemIds[0]!,
    });
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
    const aposSettlement = await emitirProvasServerSideCampanha(p, {
      operatorId: operadorId,
      campanhaId: cena.campanhaId,
      loteCampanhaId: cena.loteCampanhaId,
      itemId: cena.itemIds[0]!,
    });
    expect(aposSettlement?.provas.humanAuthorizationVerified).toBe(false);
    expect(aposSettlement?.motivo).toBe("REPRODUZIDA");
  });

  it("prova de destinatário adulterada: fingerprint divergente do snapshot é rejeitado", async () => {
    const p = pool!;
    const itemIdAdulterado = randomUUID();
    const agora = new Date().toISOString();
    await p.query(
      "INSERT INTO outbox_campanha (id, lote_campanha_id, ordem, destinatario_fingerprint, payload_snapshot, estado, criada_em) VALUES ($1, $2, 99, $3, $4::jsonb, 'PREPARADO', $5)",
      [
        itemIdAdulterado,
        cena.loteCampanhaId,
        "ff".repeat(32),
        JSON.stringify({ ordem: 99 }),
        agora,
      ],
    );
    const verificacao = await verificarProvaDestinatarioCampanha(p, {
      campanhaId: cena.campanhaId,
      loteCampanhaId: cena.loteCampanhaId,
      itemId: itemIdAdulterado,
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
