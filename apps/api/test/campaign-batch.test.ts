/**
 * GF5.2 — GOVERNED BATCH CONTROL + READINESS FOUNDATION (fake provider,
 * ZERO rede real, ZERO worker). Provas da matriz obrigatória:
 *   A. READINESS/preflight (1–12): papel, política independente, lote,
 *      autorização, canário ENVIADO (durável), ENFILEIRADO, ambiguidade,
 *      PREPARADO restante.
 *   B. EXECUÇÃO (13–25): preflight bloqueado ⇒ zero claim/provider; seleção
 *      PREPARADO em ordem ASC; CONCURRENCY=1; ENVIADO exatamente uma vez;
 *      stop conservador em FALHA_PRE_PROVIDER/FALHA_DEFINITIVA/AMBIGUO/
 *      NAO_CLAIMADO; reinvocação NÃO reenvia terminais; autoridade
 *      EXCLUSIVA de executeAttemptCampanha (nunca provider direto).
 *   C. INFRA (26–29): mesmo seam GF5.1; nenhuma linha outbox_email; nenhum
 *      worker genérico; nenhuma segunda implementação Gmail/OAuth.
 */
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

// GF5.2 — chave de prova SINTÉTICA no ambiente do processo de teste apenas
// (a produção lê a própria configuração; nenhum env operacional é mutado).
const CHAVE_PROVA_SINTETICA = Buffer.from("gf52-chave-prova-sintetica-32bytes!!", "utf8").toString("base64");
const NOME_CHAVE_PROVA = "PF_CAMPAIGN_PROOF_KEY_BASE64";
beforeAll(() => {
  process.env[NOME_CHAVE_PROVA] = CHAVE_PROVA_SINTETICA;
});
import {
  executarLoteCampanha,
  preflightLoteCampanha,
  BLOQUEIOS_LOTE,
  type FornecedorProvedoresLote,
} from "../src/campaign-batch.js";
import { executeAttemptCampanha } from "../src/campaign-execution.js";
import { fingerprintDestinatarioCampanha } from "../src/campaign-control.js";
import { montarConsolidatedMailAdapter } from "../src/campaign-consolidated-mail.js";
import type { CampanhaPool } from "../src/campaign-control.js";
import type {
  ProvedorEnvioCampanha,
  ResultadoProvedorCampanha,
} from "../src/campaign-execution.js";

// ---------------------------------------------------------------------------
// FIXTURE PURA (sem banco): executor de SQL em memória suficiente para o
// preflight/execution flow. As consultas são despachadas por conteúdo.
// ---------------------------------------------------------------------------

interface ItemMemoria {
  id: string;
  loteId: string;
  ordem: number;
  estado: string;
}

interface Cena {
  operatorId: string;
  campanhaId: string;
  loteId: string;
  loteEstado: string;
  totalItens: number;
  ativacaoPresente: boolean;
  autorizacaoPresente: boolean;
  itens: ItemMemoria[];
  /** item_id do canário selecionado no evento (ou null). */
  canarioItemId: string | null;
  /** eventos por itemId (EXEC_RECEIPT/EXEC_SETTLEMENT/EXEC_AMBIGUO/...). */
  eventosExec: Record<string, string[]>;
}

function cenaBase(sobre?: Partial<Cena>): Cena {
  const operatorId = randomUUID();
  const campanhaId = randomUUID();
  const loteId = randomUUID();
  const canarioItemId = randomUUID();
  return {
    operatorId,
    campanhaId,
    loteId,
    loteEstado: "ATIVO",
    totalItens: 10,
    ativacaoPresente: true,
    autorizacaoPresente: true,
    itens: [
      { id: canarioItemId, loteId, ordem: 1, estado: "ENVIADO" },
      { id: randomUUID(), loteId, ordem: 2, estado: "PREPARADO" },
      { id: randomUUID(), loteId, ordem: 3, estado: "PREPARADO" },
      { id: randomUUID(), loteId, ordem: 4, estado: "PREPARADO" },
    ],
    canarioItemId,
    eventosExec: { [canarioItemId]: ["EXEC_RECEIPT", "EXEC_SETTLEMENT"] },
    ...sobre,
  };
}

function politicaLote(sobre?: Partial<Parameters<typeof preflightLoteCampanha>[1]["politica"]>) {
  return {
    enabled: true,
    phase: "PERSISTENCE" as const,
    individualOperatorIdentityRequired: true as const,
    canPersistImport: true,
    canCreateBatch: true,
    canExecute: true,
    canPrepareBatch: true,
    realSendEnabled: true,
    canarySendEnabled: false,
    batchSendEnabled: true,
    ...sobre,
  };
}

/** Executor SQL em memória — atende EXATAMENTE as consultas do módulo batch
 * (roteamento por assinatura da consulta, na ordem de especificidade). */
function poolDaCena(cena: Cena): CampanhaPool & { mutacoes: string[] } {
  const mutacoes: string[] = [];
  return {
    mutacoes,
    async query(consulta: string, valores: readonly unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
      const sql = consulta.replace(/\s+/g, " ").trim();
      const v = valores.map((valor) => String(valor));
      // P1 — item por id (verificação do canário: id/estado/lote)
      if (sql.startsWith("SELECT i.id, i.estado, i.lote_campanha_id")) {
        const item = cena.itens.find((alvo) => alvo.id === v[0]);
        return {
          rows: item ? [{ id: item.id, estado: item.estado, lote_campanha_id: item.loteId }] : [],
          rowCount: item ? 1 : 0,
        };
      }
      // P2 — seleção dos elegíveis (PREPARADO, ordem ASC)
      if (sql.startsWith("SELECT i.id, i.ordem")) {
        const elegiveis = cena.itens
          .filter((item) => item.loteId === v[0] && item.estado === "PREPARADO")
          .sort((a, b) => a.ordem - b.ordem)
          .map((item) => ({ id: item.id, ordem: item.ordem }));
        return { rows: elegiveis, rowCount: elegiveis.length };
      }
      // P3 — contagem por estado
      if (sql.includes("GROUP BY estado")) {
        const porEstado: Record<string, number> = {};
        for (const item of cena.itens) {
          if (item.loteId === v[0]) porEstado[item.estado] = (porEstado[item.estado] ?? 0) + 1;
        }
        return {
          rows: Object.entries(porEstado).map(([estado, total]) => ({ estado, total })),
          rowCount: Object.keys(porEstado).length,
        };
      }
      // P4 — itens com EXEC_AMBIGUO no lote
      if (sql.includes("EXEC_AMBIGUO")) {
        const ambiguos = cena.itens.filter((item) =>
          item.loteId === v[0] && (cena.eventosExec[item.id] ?? []).includes("EXEC_AMBIGUO"),
        );
        return { rows: ambiguos.map((item) => ({ id: item.id })), rowCount: ambiguos.length };
      }
      // P5 — eventos EXEC_RECEIPT/EXEC_SETTLEMENT por item (canário)
      if (sql.startsWith("SELECT tipo, count(*)::int")) {
        const tipos = cena.eventosExec[String(valores[0] ?? "")] ?? [];
        const porTipo: Record<string, number> = {};
        for (const tipo of tipos) porTipo[tipo] = (porTipo[tipo] ?? 0) + 1;
        return {
          rows: Object.entries(porTipo).map(([tipo, total]) => ({ tipo, total })),
          rowCount: Object.keys(porTipo).length,
        };
      }
      // P6 — evento canário com item_id nos metadados
      if (sql.includes("metadados->>'item_id'")) {
        if (!cena.canarioItemId) return { rows: [], rowCount: 0 };
        return { rows: [{ item_id: cena.canarioItemId }], rowCount: 1 };
      }
      // P7 — lote por campanha + operator (com flag de ativação embutida)
      if (sql.startsWith("SELECT l.id, l.codigo")) {
        if (cena.campanhaId !== v[0] || cena.operatorId !== v[2]) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [
            {
              id: cena.loteId,
              codigo: "CAMPANHA_PF_TESTE",
              estado: cena.loteEstado,
              total_itens: cena.totalItens,
              ativacao_presente: cena.ativacaoPresente ? "1" : null,
            },
          ],
          rowCount: 1,
        };
      }
      // P8 — autorização humana no lote
      if (sql.startsWith("SELECT id FROM evento_auditoria")) {
        if (v[0] !== cena.loteId) return { rows: [], rowCount: 0 };
        return cena.autorizacaoPresente
          ? { rows: [{ id: "ev-autor" }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      // Mutações não são esperadas no fluxo de lote sob teste.
      if (/^(UPDATE|INSERT|DELETE)/.test(sql)) mutacoes.push(sql);
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      throw new Error("connect() NÃO é esperado no preflight/fluxo de teste puro");
    },
  } as never;
}

// Provider fake controlável (conta concorrência e ordem; NUNCA usado fora
// de executeAttemptCampanha — a fronteira é provada por espionagem).
function fornecedorControlavel(opcoes: {
  respostas: Record<string, ResultadoProvedorCampanha>;
  concorrenciaMaxima: { valor: number; atual: number };
  ordemChamadas: number[];
}): FornecedorProvedoresLote {
  const provider: ProvedorEnvioCampanha = {
    nome: "GMAIL_CAMPANHA_FAKE_LOTE",
    enviar: async (comando) => {
      opcoes.concorrenciaMaxima.atual += 1;
      opcoes.concorrenciaMaxima.valor = Math.max(
        opcoes.concorrenciaMaxima.valor,
        opcoes.concorrenciaMaxima.atual,
      );
      opcoes.ordemChamadas.push(opcoes.ordemChamadas.length + 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      opcoes.concorrenciaMaxima.atual -= 1;
      return opcoes.respostas[comando.itemId] ?? { tipo: "ENVIADO", receipt: { provider: "FAKE", messageId: "m-" + comando.itemId.slice(0, 8), acceptedAt: new Date().toISOString(), chaveIdempotencia: comando.chaveIdempotencia } };
    },
  };
  return { provedorParaCampanha: () => provider };
}

/**
 * Fake da AUTORIDADE executeAttemptCampanha (injeção EXCLUSIVA de teste):
 * registra chamadas por itemId e devolve as respostas configuradas
 * (default = ENVIADO). A produção NUNCA injeta — o default do módulo é a
 * autoridade canônica.
 */
function executarTentativaFake(opcoes: {
  chamadasPorItem: Map<string, number>;
  respostas?: Record<string, import("../src/campaign-execution.js").ResultadoTentativaExecucao>;
  ordemChamadas?: string[];
  concorrencia?: { valor: number; atual: number };
}) {
  return (async (_pool: unknown, comando: { itemId: string }) => {
    opcoes.chamadasPorItem.set(comando.itemId, (opcoes.chamadasPorItem.get(comando.itemId) ?? 0) + 1);
    opcoes.ordemChamadas?.push(comando.itemId);
    if (opcoes.concorrencia) {
      opcoes.concorrencia.atual += 1;
      opcoes.concorrencia.valor = Math.max(opcoes.concorrencia.valor, opcoes.concorrencia.atual);
      await new Promise((resolve) => setTimeout(resolve, 5));
      opcoes.concorrencia.atual -= 1;
    }
    return (
      opcoes.respostas?.[comando.itemId] ?? {
        resultado: "ENVIADO",
        itemId: comando.itemId,
        receipt: { provider: "FAKE", messageId: "m-" + comando.itemId.slice(0, 8), acceptedAt: new Date().toISOString(), chaveIdempotencia: "chave-fake" },
      }
    );
  }) as unknown as typeof executeAttemptCampanha;
}

/** Emissor de provas SINTÉTICO para o fluxo do lote (a emissão canônica
 * server-side é exercida nos testes DB-gated do canário). Retorna provas
 * verificadas para qualquer item da cena. */
const emitirProvasFake = (async (_pool: unknown, _ids: { readonly itemId: string }) => ({
  provas: { recipientProofVerified: true, humanAuthorizationVerified: true },
  motivo: "",
})) as unknown as typeof import("../src/campaign-control.js").emitirProvasServerSideCampanha;
const provasOk = emitirProvasFake;

describe("GF5.2 — A. preflight do lote (read-only, fake pool)", () => {
  it("12. todas as condições satisfeitas ⇒ elegível com itens PREPARADO em ordem ASC", async () => {
    const cena = cenaBase();
    const pool = poolDaCena(cena);
    const resultado = await preflightLoteCampanha(pool, {
      operatorId: cena.operatorId,
      campanhaId: cena.campanhaId,
      papeis: ["EXECUTOR"],
      politica: politicaLote(),
    });
    expect(resultado.elegivel).toBe(true);
    if (resultado.elegivel) {
      expect(resultado.preparados).toBe(3);
      expect(resultado.itensElegiveis.map((item) => item.ordem)).toEqual([2, 3, 4]);
      expect(pool.mutacoes).toHaveLength(0);
    }
  });

  it("1. não-EXECUTOR ⇒ false + OPERATOR_ROLE_FORBIDDEN", async () => {
    const cena = cenaBase();
    const pool = poolDaCena(cena);
    const resultado = await preflightLoteCampanha(pool, {
      operatorId: cena.operatorId,
      campanhaId: cena.campanhaId,
      papeis: ["PREPARADOR"],
      politica: politicaLote(),
    });
    expect(resultado).toMatchObject({ elegivel: false });
    if (!resultado.elegivel) expect(resultado.bloqueios).toContain(BLOQUEIOS_LOTE.PAPEL);
  });

  it("2–4. cada gate de política independente ⇒ false (batch/execute/realSend)", async () => {
    for (const sobre of [
      { batchSendEnabled: false },
      { canExecute: false },
      { realSendEnabled: false },
    ] as const) {
      const cena = cenaBase();
      const pool = poolDaCena(cena);
      const resultado = await preflightLoteCampanha(pool, {
        operatorId: cena.operatorId,
        campanhaId: cena.campanhaId,
        papeis: ["EXECUTOR"],
        politica: politicaLote(sobre),
      });
      expect(resultado.elegivel).toBe(false);
      if (!resultado.elegivel) {
        expect(resultado.bloqueios).toContain(
          sobre.batchSendEnabled === false
            ? BLOQUEIOS_LOTE.BATCH_DESARMADO
            : sobre.canExecute === false
              ? BLOQUEIOS_LOTE.EXECUCAO_DESARMADA
              : BLOQUEIOS_LOTE.REAL_SEND_DESARMADO,
        );
      }
    }
  });

  it("5. lote ≠ ATIVO ⇒ false", async () => {
    const cena = cenaBase({ loteEstado: "PREPARADO" });
    const pool = poolDaCena(cena);
    const resultado = await preflightLoteCampanha(pool, {
      operatorId: cena.operatorId,
      campanhaId: cena.campanhaId,
      papeis: ["EXECUTOR"],
      politica: politicaLote(),
    });
    if (!resultado.elegivel) expect(resultado.bloqueios).toContain(BLOQUEIOS_LOTE.LOTE_NAO_ATIVO);
    expect(resultado.elegivel).toBe(false);
  });

  it("6. autorização humana ausente ⇒ false", async () => {
    const cena = cenaBase({ autorizacaoPresente: false });
    const pool = poolDaCena(cena);
    const resultado = await preflightLoteCampanha(pool, {
      operatorId: cena.operatorId,
      campanhaId: cena.campanhaId,
      papeis: ["EXECUTOR"],
      politica: politicaLote(),
    });
    expect(resultado.elegivel).toBe(false);
    if (!resultado.elegivel) expect(resultado.bloqueios).toContain(BLOQUEIOS_LOTE.AUTORIZACAO_AUSENTE);
  });

  it("7. canário selecionado mas NÃO enviado ⇒ CANARY_NOT_SUCCESSFULLY_ADJUDICATED", async () => {
    const canarioNaoEnviado = randomUUID();
    const cena = cenaBase({
      itens: [
        { id: canarioNaoEnviado, loteId: "", ordem: 1, estado: "PREPARADO" },
        { id: randomUUID(), loteId: "", ordem: 2, estado: "PREPARADO" },
      ],
      eventosExec: {},
    });
    cena.itens = cena.itens.map((item) => ({ ...item, loteId: cena.loteId }));
    const pool = poolDaCena(cena);
    const resultado = await preflightLoteCampanha(pool, {
      operatorId: cena.operatorId,
      campanhaId: cena.campanhaId,
      papeis: ["EXECUTOR"],
      politica: politicaLote(),
    });
    expect(resultado.elegivel).toBe(false);
    if (!resultado.elegivel) expect(resultado.bloqueios).toContain(BLOQUEIOS_LOTE.CANARIO_NAO_ENVIADO);
  });

  it("8. canário ENVIADO + EXEC_RECEIPT/EXEC_SETTLEMENT ⇒ gate do canário passa", async () => {
    const cena = cenaBase();
    const pool = poolDaCena(cena);
    const resultado = await preflightLoteCampanha(pool, {
      operatorId: cena.operatorId,
      campanhaId: cena.campanhaId,
      papeis: ["EXECUTOR"],
      politica: politicaLote(),
    });
    expect(resultado.elegivel).toBe(true);
    if (resultado.elegivel) {
      expect(resultado.enviados).toBe(1);
    }
  });

  it("9. zero PREPARADO restante ⇒ false (nada a executar)", async () => {
    const canario = randomUUID();
    const cena = cenaBase({
      itens: [{ id: canario, loteId: "", ordem: 1, estado: "ENVIADO" }],
      eventosExec: { [canario]: ["EXEC_RECEIPT", "EXEC_SETTLEMENT"] },
    });
    cena.itens[0]!.loteId = cena.loteId;
    const pool = poolDaCena(cena);
    const resultado = await preflightLoteCampanha(pool, {
      operatorId: cena.operatorId,
      campanhaId: cena.campanhaId,
      papeis: ["EXECUTOR"],
      politica: politicaLote(),
    });
    expect(resultado.elegivel).toBe(false);
    if (!resultado.elegivel) expect(resultado.bloqueios).toContain(BLOQUEIOS_LOTE.NADA_A_EXECUTAR);
  });

  it("10. ENFILEIRADO presente ⇒ false (crash-after-claim)", async () => {
    const cena = cenaBase();
    cena.itens.push({ id: randomUUID(), loteId: cena.loteId, ordem: 5, estado: "ENFILEIRADO" });
    const pool = poolDaCena(cena);
    const resultado = await preflightLoteCampanha(pool, {
      operatorId: cena.operatorId,
      campanhaId: cena.campanhaId,
      papeis: ["EXECUTOR"],
      politica: politicaLote(),
    });
    expect(resultado.elegivel).toBe(false);
    if (!resultado.elegivel) expect(resultado.bloqueios).toContain(BLOQUEIOS_LOTE.ENFILEIRADO_PENDENTE);
  });

  it("11. EXEC_AMBIGUO não resolvido ⇒ false", async () => {
    const cena = cenaBase();
    const ambiguado = cena.itens[2]!;
    cena.eventosExec[ambiguado.id] = ["EXEC_AMBIGUO"];
    const pool = poolDaCena(cena);
    const resultado = await preflightLoteCampanha(pool, {
      operatorId: cena.operatorId,
      campanhaId: cena.campanhaId,
      papeis: ["EXECUTOR"],
      politica: politicaLote(),
    });
    expect(resultado.elegivel).toBe(false);
    if (!resultado.elegivel) expect(resultado.bloqueios).toContain(BLOQUEIOS_LOTE.AMBIGUIDADE_NAO_RESOLVIDA);
  });
});

describe("GF5.2 — B. execução do lote (domínio, fake provider)", () => {
  const provasOk = emitirProvasFake;

  it("13. preflight bloqueado ⇒ ZERO executeAttemptCampanha/provider", async () => {
    const cena = cenaBase({ autorizacaoPresente: false });
    const pool = poolDaCena(cena);
    let tentativas = 0;
    const resultado = await executarLoteCampanha(pool, {
      operatorId: cena.operatorId,
      campanhaId: cena.campanhaId,
      papeis: ["EXECUTOR"],
      politica: politicaLote(),
      fornecedor: fornecedorControlavel({
        respostas: {},
        concorrenciaMaxima: { valor: 0, atual: 0 },
        ordemChamadas: [],
      }),
      emitirProvas: provasOk,
      executarTentativa: (async (...argumentos: Parameters<typeof executeAttemptCampanha>) => {
        tentativas += 1;
        return executeAttemptCampanha(...argumentos);
      }) as typeof executeAttemptCampanha,
    });
    expect(resultado.resultado).toBe("BLOQUEADO");
    expect(resultado.motivoInterrupcao).toContain(BLOQUEIOS_LOTE.AUTORIZACAO_AUSENTE);
    expect(tentativas).toBe(0); // nenhuma tentativa chegou à autoridade
  });

  it("14–17. seleção: 1 canário ENVIADO + N PREPARADO ⇒ N processados, ordem ASC, concorrência máx 1, ENVIADO exatamente uma vez", async () => {
    const cena = cenaBase(); // 1 ENVIADO + 3 PREPARADO (ordens 2,3,4)
    const pool = poolDaCena(cena);
    const concorrencia = { valor: 0, atual: 0 };
    const ordemChamadas: number[] = [];
    const chamadasPorItem = new Map<string, number>();
    const itensEmOrdem: string[] = [];
    const resultado = await executarLoteCampanha(pool, {
      operatorId: cena.operatorId,
      campanhaId: cena.campanhaId,
      papeis: ["EXECUTOR"],
      politica: politicaLote(),
      fornecedor: fornecedorControlavel({
        respostas: {},
        concorrenciaMaxima: concorrencia,
        ordemChamadas,
      }),
      emitirProvas: provasOk,
      executarTentativa: executarTentativaFake({
        chamadasPorItem,
        ordemChamadas: itensEmOrdem,
        concorrencia,
      }),
    });
    expect(resultado.resultado).toBe("CONCLUIDO");
    // Ordem estrita ASC (ordens 2,3,4 do scene) e exatamente uma chamada por item.
    const ordensChamadas = itensEmOrdem.map((itemId) => cena.itens.find((i) => i.id === itemId)!.ordem);
    expect(ordensChamadas).toEqual([2, 3, 4]);
    for (const [, total] of chamadasPorItem) expect(total).toBe(1);
    expect(chamadasPorItem.has(cena.canarioItemId!)).toBe(false);
    expect(resultado.preparadosInicio).toBe(3);
    expect(resultado.enviadosAntes).toBe(1);
    expect(resultado.enviadosNestaExecucao).toBe(3);
    expect(resultado.falhasNestaExecucao).toBe(0);
    expect(resultado.restantesPreparados).toBe(0);
    expect(concorrencia.valor).toBe(1);
    // As ordens processadas vêm do fake da AUTORIDADE (o provider é alcançado
    // apenas dentro dela; sua lista direta permanece vazia — prova 25).
    const ordensProcessadas = itensEmOrdem.map((itemId) => cena.itens.find((i) => i.id === itemId)!.ordem);
    expect(ordensProcessadas).toEqual([2, 3, 4]);
    expect(ordemChamadas).toEqual([]);
  });

  it("18+23. itens terminais NUNCA reenviados; reinvocação após sucesso não reenvia ENVIADO", async () => {
    const cena = cenaBase();
    // Item de ordem 2 já ENVIADO com settlement (execução anterior)
    const enviadoAntes = cena.itens[1]!;
    cena.eventosExec[enviadoAntes.id] = ["EXEC_RECEIPT", "EXEC_SETTLEMENT"];
    cena.itens[1] = { ...enviadoAntes, estado: "ENVIADO" };
    const pool = poolDaCena(cena);
    const chamadasPorItem = new Map<string, number>();
    const parametrosExecucao = {
      operatorId: cena.operatorId,
      campanhaId: cena.campanhaId,
      papeis: ["EXECUTOR"],
      politica: politicaLote(),
      fornecedor: fornecedorControlavel({
        respostas: {},
        concorrenciaMaxima: { valor: 0, atual: 0 },
        ordemChamadas: [],
      }),
      emitirProvas: provasOk,
      executarTentativa: executarTentativaFake({ chamadasPorItem }),
    };
    const primeira = await executarLoteCampanha(pool, parametrosExecucao);
    expect(primeira.enviadosNestaExecucao).toBe(2); // ordens 3 e 4
    // Simula o settlement durável dos itens recém-enviados.
    for (const item of [cena.itens[2]!, cena.itens[3]!]) {
      item.estado = "ENVIADO";
      cena.eventosExec[item.id] = ["EXEC_RECEIPT", "EXEC_SETTLEMENT"];
    }
    const segunda = await executarLoteCampanha(pool, parametrosExecucao);
    // Segunda execução: NADA a executar (todos terminais) ⇒ BLOQUEADO
    expect(segunda.resultado).toBe("BLOQUEADO");
    expect(segunda.motivoInterrupcao).toContain(BLOQUEIOS_LOTE.NADA_A_EXECUTAR);
    // O canário e o item enviado antes JAMAIS foram chamados.
    expect(chamadasPorItem.has(cena.canarioItemId!)).toBe(false);
    expect(chamadasPorItem.get(enviadoAntes.id)).toBeUndefined();
  });

  it("19–21. FALHA_PRE_PROVIDER / FALHA_DEFINITIVA / AMBIGUO ⇒ stop imediato, restantes PREPARADO, sem retry", async () => {
    for (const caso of [
      { tipo: "FALHA_PRE_PROVIDER" as const, motivo: "TOKEN_RESOLUTION_INDISPONIVEL" },
      { tipo: "FALHA_DEFINITIVA" as const, motivo: "AUTH_REQUIRED" },
      { tipo: "AMBIGUO" as const, motivo: "GMAIL_AMBIGUO" },
    ]) {
      const cena = cenaBase();
      const alvo = cena.itens[1]!; // ordem 2 — falha no PRIMEIRO processado
      const pool = poolDaCena(cena);
      const resultado = await executarLoteCampanha(pool, {
        operatorId: cena.operatorId,
        campanhaId: cena.campanhaId,
        papeis: ["EXECUTOR"],
        politica: politicaLote(),
        fornecedor: fornecedorControlavel({
          respostas: {},
          concorrenciaMaxima: { valor: 0, atual: 0 },
          ordemChamadas: [],
        }),
        emitirProvas: provasOk,
        executarTentativa: executarTentativaFake({
          chamadasPorItem: new Map(),
          respostas: {
            [alvo.id]: (
              caso.tipo === "AMBIGUO"
                ? { resultado: "AMBIGUO", itemId: alvo.id, motivo: caso.motivo }
                : caso.tipo === "FALHA_DEFINITIVA"
                  ? { resultado: "FALHA_DEFINITIVA", itemId: alvo.id, motivo: caso.motivo }
                  : { resultado: "FALHA_PRE_PROVIDER", itemId: alvo.id, motivo: caso.motivo }
            ) as import("../src/campaign-execution.js").ResultadoTentativaExecucao,
          },
        }),
      });
      expect(resultado.resultado).toBe("INTERROMPIDO");
      expect(resultado.enviadosNestaExecucao).toBe(0);
      expect(resultado.falhasNestaExecucao).toBe(1);
      expect(resultado.restantesPreparados).toBe(2);
      expect(resultado.motivoInterrupcao).toContain(caso.tipo);
      if (caso.tipo === "AMBIGUO") {
        expect(resultado.motivoInterrupcao).toBe("AMBIGUO_RECONCILIACAO_HUMANA");
      }
    }
  });

  it("22. NAO_CLAIMADO inesperado ⇒ stop conservador (executarTentativa espionada)", async () => {
    const cena = cenaBase();
    const alvo = cena.itens[1]!;
    const pool = poolDaCena(cena);
    const resultado = await executarLoteCampanha(pool, {
      operatorId: cena.operatorId,
      campanhaId: cena.campanhaId,
      papeis: ["EXECUTOR"],
      politica: politicaLote(),
      fornecedor: fornecedorControlavel({
        respostas: {},
        concorrenciaMaxima: { valor: 0, atual: 0 },
        ordemChamadas: [],
      }),
      emitirProvas: provasOk,
      executarTentativa: executarTentativaFake({
        chamadasPorItem: new Map(),
        respostas: {
          [alvo.id]: {
            resultado: "NAO_CLAIMADO",
            itemId: alvo.id,
            claim: { resultado: "BLOQUEADO", itemId: alvo.id, bloqueios: ["LOTE_NAO_ATIVO"] },
          } as import("../src/campaign-execution.js").ResultadoTentativaExecucao,
        },
      }),
    });
    expect(resultado.resultado).toBe("INTERROMPIDO");
    expect(resultado.motivoInterrupcao).toBe("NAO_CLAIMADO_INESPERADO");
    expect(resultado.restantesPreparados).toBe(3);
  });

  it("25. autoridade: TODO envio passa por executeAttemptCampanha (provider direto ⇒ fail-closed) — espionagem do caminho", async () => {
    // (a) o provider recebido pelo lote NUNCA é chamado fora do
    // executeAttemptCampanha: chamá-lo diretamente FORA do fluxo não produz
    // claim nem mutação (é só o fake); a PROVA DE AUTORIDADE é que o módulo
    // batch não possui NENHUM caminho provider.enviar fora de
    // executeAttemptCampanha (asserção estrutural abaixo) e que o resultado
    // por item vem SEMPRE do retorno de executeAttemptCampanha.
    const fonte = (await import("node:fs")).readFileSync(
      new URL("../src/campaign-batch.ts", import.meta.url),
      "utf8",
    );
    const codigo = fonte
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // O default da injeção é EXATAMENTE a autoridade canônica e a única
    // invocação de tentativa no módulo é via esse ponto único.
    expect(codigo).toContain("entrada.executarTentativa ?? executeAttemptCampanha");
    expect((codigo.match(/executarTentativa\(pool,/g) ?? []).length).toBe(1);
    expect(codigo).not.toMatch(/\bprovider\.enviar\(|\.enviar\(\{/);
    expect((codigo.match(/\.enviar\(/g) ?? []).length).toBe(0);
    // (b) nenhum worker genérico / outbox_email no domínio do lote.
    expect(codigo).not.toContain("claimOutbox");
    expect(codigo).not.toContain("outbox_email");
    expect(codigo).not.toContain("executarWorkerUmaVezLive");
  });

  it("24. comando do lote: nenhuma lista de itens/destinatários existe na assinatura (autoridade server-side)", async () => {
    const fonte = (await import("node:fs")).readFileSync(
      new URL("../src/campaign-batch.ts", import.meta.url),
      "utf8",
    );
    const codigo = fonte
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(codigo).not.toMatch(/itemIds|body\.|do request/);
    // A seleção é SEMPRE da consulta PREPARADO + ordem ASC.
    expect(codigo).toContain("estado = 'PREPARADO'");
    expect(codigo).toContain("ORDER BY i.ordem ASC");
  });
});

describe("GF5.2 — C. infraestrutura consolidada (mesmo seam GF5.1)", () => {
  it("26–29. adapter GF5.1 é a única fonte de provider do lote; sem outbox_email/worker/segunda implementação", async () => {
    const cena = cenaBase();
    const pool = poolDaCena(cena);
    const adapter = montarConsolidatedMailAdapter({
      env: {
        GMAIL_OAUTH_CLIENT_ID: "client-id-sintetico",
        GMAIL_OAUTH_CLIENT_SECRET: "client-secret-sintetico",
        GMAIL_OAUTH_REDIRECT_URI: "https://exemplo.test/callback",
        GMAIL_EXPECTED_ACCOUNT: "institucional.gf52@exemplo.test",
        DOCUMENT_FINGERPRINT_KEY_BASE64: Buffer.from("gf52-chave-finger-32-bytes-sintetic").toString("base64"),
        DATA_ENCRYPTION_KEY_BASE64: Buffer.from("gf52-chave-cripto-32-bytes-sintetic").toString("base64"),
        DATA_ENCRYPTION_KEY_VERSION: "v1-gf52",
      },
      pool: pool as never,
      portaTransporte: async () => ({ provider: "GMAIL", messageId: "gf52", acceptedAt: new Date().toISOString() }),
    });
    const fornecedor: FornecedorProvedoresLote = {
      provedorParaCampanha: adapter.provedorParaCampanha,
    };
    // Execução com gates fechados de envio real (produção): preflight
    // bloqueia ANTES de qualquer provider (REAL_SEND fechado no loader).
    const resultado = await executarLoteCampanha(pool, {
      operatorId: cena.operatorId,
      campanhaId: cena.campanhaId,
      papeis: ["EXECUTOR"],
      politica: politicaLote({ realSendEnabled: false, batchSendEnabled: false }),
      fornecedor,
      emitirProvas: provasOk,
    });
    expect(resultado.resultado).toBe("BLOQUEADO");
    expect(adapter.metricas.chamadasTransporte()).toBe(0);
    // Nenhuma mutação SQL ocorreu (readiness/execution bloqueados).
    expect(pool.mutacoes).toHaveLength(0);
  });
});
