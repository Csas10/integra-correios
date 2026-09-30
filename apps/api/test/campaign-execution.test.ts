/**
 * SLICE-03A.1 — Suíte da fundação de EXECUÇÃO da Campanha PF (NO SEND).
 *
 * Estrutura (classificação honesta por natureza da prova):
 *   · BEHAVIORAL (puro/local): política, elegibilidade, idempotência.
 *   · SOURCE_STRUCTURE (leitura de fonte): autoridade única da política,
 *     entrypoint único, segregação do piloto, zero rede, SQL parametrizado.
 *   · POSTGRESQL_INTEGRATION (DB-gated, PG16): fixtures sintéticas únicas,
 *     corrida do claim, reconstrução pós-restart, corrida de cancelamento.
 *
 * Classificação de saída: POSTGRESQL_INTEGRATION=PENDING_CI quando
 * DATABASE_URL não está configurada (sandbox local) — NUNCA falsificada.
 * NENHUMA campanha operacional real pode ser usada como fixture:
 * todas as fixtures são UUIDs sintéticos gerados por execução.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  avaliarElegibilidadeExecucaoItem,
  chaveIdempotenciaExecucao,
  executeAttemptCampanha,
  ProvedorFakeCampanha,
  type CampanhaPool,
  type PoliticaExecucaoCampanha,
} from "../src/campaign-execution.js";
import { carregarPoliticaCampanhaAtualizacao, hashAprovacaoCampanha } from "../src/campaigns.js";
import { fingerprintDestinatarioCampanha } from "../src/campaign-control.js";
import {
  contentHashDoTemplate,
  metadadosTemplate,
  TEMPLATE_V2_VERSION,
} from "@integra-correios/mail";

const DB_URL_AMBIENTE = process.env.DATABASE_URL;

afterAll(() => {
  // Restaura o ambiente do processo para não vazar flags entre arquivos de teste.
  if (DB_URL_AMBIENTE === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = DB_URL_AMBIENTE;
});

const politicaFechada: PoliticaExecucaoCampanha = {
  enabled: false,
  phase: "FOUNDATION",
  individualOperatorIdentityRequired: true,
  canPersistImport: false,
  canCreateBatch: false,
  canExecute: false,
  canPrepareBatch: false,
  realSendEnabled: false,
  canarySendEnabled: false,
};
const politicaAberta: PoliticaExecucaoCampanha = {
  ...politicaFechada,
  canExecute: true,
  realSendEnabled: true,
};

/**
 * Provas SINTÉTICAS — exclusivas do teste para exercitar o domínio. O emissor
 * server-side real (verificador de destinatário + autorização humana) NÃO é
 * implementado nesta fatia (PRODUCTION_PROOF_ISSUER_IMPLEMENTED=false).
 */
const provasSinteticas = {
  recipientProofVerified: true,
  humanAuthorizationVerified: true,
} as const;

// Fonte do módulo sob teste — usada pelas provas estruturais (Parte 3).
const FONTE_EXECUCAO = readFileSync(
  new URL("../src/campaign-execution.ts", import.meta.url),
  "utf-8",
);
const FONTE_CAMPAIGNS = readFileSync(
  new URL("../src/campaigns.ts", import.meta.url),
  "utf-8",
);
const FONTE_PILOT_DOMAIN = readFileSync(
  new URL("../src/pilot-domain.ts", import.meta.url),
  "utf-8",
);
const FONTE_PILOT = readFileSync(
  new URL("../src/pilot.ts", import.meta.url),
  "utf-8",
);
const FONTE_WORKER = readFileSync(
  new URL("../../../packages/persistence/src/postgres.ts", import.meta.url),
  "utf-8",
);

/** Extrai o corpo de uma função nomeada da fonte (para provas delimitadas). */
function trechoFuncao(fonte: string, nome: string, janela = 6000): string {
  const inicio = fonte.indexOf("function " + nome);
  if (inicio < 0) throw new Error("função não encontrada na fonte: " + nome);
  return fonte.slice(inicio, inicio + janela);
}

/** Remove comentarios (provas estruturais examinam CODIGO, nao doc-comments). */
function codigoSemComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// Parte 1 — BEHAVIORAL: política com AUTORIDADE ÚNICA (fronteira campaigns.ts)
// O módulo de execução não interpreta ambiente: recebe PfUpdateCampaignPolicy.
// ---------------------------------------------------------------------------

describe("SLICE_03A.1 — política: autoridade única e fail-closed (BEHAVIORAL)", () => {
  it("autoridade única: sem nenhuma flag, a política carregada é integralmente fechada", () => {
    // Slice-03B: canPrepareBatch entra na MESMA fronteira, também fechado.
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
    });
  });

  it("duplo gate: cada flag isolada NÃO abre execução; somente as duas juntas", () => {
    const soExecute = carregarPoliticaCampanhaAtualizacao({
      PF_CAMPAIGN_EXECUTE_ENABLED: "true",
    });
    expect(soExecute.canExecute).toBe(true);
    expect(soExecute.realSendEnabled).toBe(false);
    const soReal = carregarPoliticaCampanhaAtualizacao({
      REAL_SEND_ENABLED: "true",
    });
    expect(soReal.canExecute).toBe(false);
    // Comportamental: nenhuma meia-abertura torna o item elegivel...
    const base = {
      loteEstado: "ATIVO",
      itemEstado: "PREPARADO",
      codigoLote: "CAMPANHA_PF_SINTETICA",
      provas: provasSinteticas,
    };
    expect(
      avaliarElegibilidadeExecucaoItem({ politica: soExecute, ...base }).bloqueios,
    ).toEqual(["REAL_SEND_DISABLED"]);
    expect(
      avaliarElegibilidadeExecucaoItem({ politica: soReal, ...base }).bloqueios,
    ).toEqual(["EXECUTE_DISABLED"]);
    // ...e somente o duplo gate completo abre.
    const aberta = carregarPoliticaCampanhaAtualizacao({
      PF_CAMPAIGN_EXECUTE_ENABLED: "true",
      REAL_SEND_ENABLED: "true",
    });
    expect(aberta.canExecute).toBe(true);
    expect(aberta.realSendEnabled).toBe(true);
    expect(
      avaliarElegibilidadeExecucaoItem({ politica: aberta, ...base }).elegivel,
    ).toBe(true);
  });

  it("fail-closed estrito: valores diferentes do literal 'true' não abrem nada", () => {
    const politica = carregarPoliticaCampanhaAtualizacao({
      PF_CAMPAIGN_EXECUTE_ENABLED: "1",
      REAL_SEND_ENABLED: "TRUE",
    });
    expect(politica.canExecute).toBe(false);
    expect(politica.realSendEnabled).toBe(false);
  });

  it("o módulo de execução não contém NENHUM caminho de leitura de ambiente", () => {
    const CODIGO_EXECUCAO = codigoSemComentarios(FONTE_EXECUCAO);
    expect(CODIGO_EXECUCAO).not.toContain("process.env");
    expect(CODIGO_EXECUCAO).not.toContain("PF_CAMPAIGN_EXECUTE_ENABLED");
    expect(CODIGO_EXECUCAO).not.toContain("REAL_SEND_ENABLED");
        expect(CODIGO_EXECUCAO).not.toContain("DATABASE_URL");
    expect(CODIGO_EXECUCAO).not.toContain("GITHUB_");
  });

  it("a única fronteira de flags continua sendo carregarPoliticaCampanhaAtualizacao", () => {
    const corpo = trechoFuncao(FONTE_CAMPAIGNS, "carregarPoliticaCampanhaAtualizacao");
    expect(corpo).toContain('PF_CAMPAIGN_EXECUTE_ENABLED === "true"');
    expect(corpo).toContain('REAL_SEND_ENABLED === "true"');
    // Nenhuma OUTRA função de campaigns.ts interpreta a flag de execução.
    const ocorrenciasExec =
      FONTE_CAMPAIGNS.split("PF_CAMPAIGN_EXECUTE_ENABLED").length - 1;
    expect(ocorrenciasExec).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Parte 2 — BEHAVIORAL: matriz completa de estados lote×item (9 pares).
// Contrato do gate: lote EXATAMENTE ATIVO ∧ item EXATAMENTE PREPARADO.
// ---------------------------------------------------------------------------

const LOTES = ["HOLD", "PREPARADO", "ATIVO", "CANCELADO"] as const;
const ITENS = ["HOLD", "PREPARADO", "ENFILEIRADO", "ENVIADO", "FALHOU", "CANCELADO"] as const;

describe("SLICE_03A.1 — matriz de estados 9 pares lote×item (BEHAVIORAL)", () => {
  const base = {
    politica: politicaAberta,
    loteEstado: "ATIVO",
    itemEstado: "PREPARADO",
    codigoLote: "CAMPANHA_PF_SINTETICA",
    provas: provasSinteticas,
  };

  it("matriz exaustiva: exatamente (lote ATIVO, item PREPARADO) é elegível", () => {
    let paresElegiveis = 0;
    for (const loteEstado of LOTES) {
      for (const itemEstado of ITENS) {
        const avaliacao = avaliarElegibilidadeExecucaoItem({
          ...base,
          loteEstado,
          itemEstado,
        });
        const deveriaSerElegivel = loteEstado === "ATIVO" && itemEstado === "PREPARADO";
        expect(avaliacao.elegivel).toBe(deveriaSerElegivel);
        if (deveriaSerElegivel) {
          paresElegiveis += 1;
          expect(avaliacao.bloqueios).toEqual([]);
        }
      }
    }
    expect(paresElegiveis).toBe(1);
  });

  it("qualquer lote ≠ ATIVO nega com bloqueio sanitizado LOTE_NAO_ATIVO", () => {
    for (const loteEstado of LOTES.filter((e) => e !== "ATIVO")) {
      const avaliacao = avaliarElegibilidadeExecucaoItem({
        ...base,
        loteEstado,
        itemEstado: "PREPARADO",
      });
      expect(avaliacao.elegivel).toBe(false);
      expect(avaliacao.bloqueios).toContain("LOTE_NAO_ATIVO");
    }
  });

  it("item terminais (ENVIADO/FALHOU/CANCELADO) são ITEM_CONCLUIDO — nunca recapturados", () => {
    for (const itemEstado of ["ENVIADO", "FALHOU", "CANCELADO"] as const) {
      const avaliacao = avaliarElegibilidadeExecucaoItem({
        ...base,
        itemEstado,
      });
      expect(avaliacao.elegivel).toBe(false);
      expect(avaliacao.bloqueios).toContain("ITEM_CONCLUIDO");
      expect(avaliacao.bloqueios).not.toContain("ITEM_NAO_PREPARADO");
    }
  });

  it("flags fechadas + lote HOLD + item HOLD: todos os bloqueios acumulam sanitizados", () => {
    const avaliacao = avaliarElegibilidadeExecucaoItem({
      politica: politicaFechada,
      loteEstado: "HOLD",
      itemEstado: "HOLD",
      codigoLote: "CAMPANHA_PF_X",
      provas: { recipientProofVerified: false, humanAuthorizationVerified: false },
    });
    expect(avaliacao.elegivel).toBe(false);
    expect(avaliacao.bloqueios).toEqual([
      "EXECUTE_DISABLED",
      "REAL_SEND_DISABLED",
      "PROVA_DESTINATARIO_AUSENTE",
      "AUTORIZACAO_HUMANA_AUSENTE",
      "LOTE_NAO_ATIVO",
      "ITEM_NAO_PREPARADO",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Parte 2b — BEHAVIORAL: provas de autorização operacional (fail-closed).
// Flags + estados são NECESSÁRIOS mas NÃO SUFICIENTES sem recipientProof
// e humanAuthorization (emissores server-side chegam no 03B).
// ---------------------------------------------------------------------------

/**
 * SLICE_03C.2B1D — pool que registra tentativas de MUTAÇÃO e responde ao
 * SELECT de claim com uma versão de template NÃO registrada: prova o
 * fail-closed ANTES do CAS (nenhum UPDATE/INSERT/COMMIT).
 */
function poolSentinela(): CampanhaPool {
  return {
    query: async () => {
      throw new Error("SQL_PROIBIDO_NO_GATE_DE_VERSAO");
    },
    connect: async () => ({
      query: async (text: string) => {
        if (text.includes("BEGIN") || text.includes("ROLLBACK")) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("SELECT i.estado") && text.includes("template_versao") && text.includes("snapshot_registros")) {
          return {
            rows: [
              {
                item_estado: "PREPARADO",
                destinatario_fingerprint: "aa".repeat(32),
                lote_estado: "ATIVO",
                lote_codigo: "CAMPANHA_PF_SINTETICA",
                hash_aprovacao: "bb".repeat(32),
                operator_id: "3c3d3e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
                template_versao: "v-sentinel-nao-registrada-2B1D",
              },
            ],
            rowCount: 1,
          };
        }
        throw new Error("SQL_MUTANTE_PROIBIDO_SEM_PROVAS: " + text.slice(0, 60));
      },
      release: () => undefined,
    }),
  };
}

/** Pool que transformaria QUALQUER query em erro — prova de zero SQL. */
function poolQueFalha(): CampanhaPool {
  return {
    query: async () => {
      throw new Error("SQL_PROIBIDO_SEM_PROVAS");
    },
    connect: async () => ({
      query: async () => {
        throw new Error("SQL_MUTANTE_PROIBIDO_SEM_PROVAS");
      },
      release: () => undefined,
    }),
  };
}

describe("SLICE_03A.2 — provas de autorização antes do claim (BEHAVIORAL)", () => {
  const ids = {
    operatorId: "3c3d3e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
    campanhaId: "4d4e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
    loteCampanhaId: "5e5f6a7b-8c9d-4e0f-8a1b-2c3d4e5f6a7b",
    itemId: "6f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c",
  };

  it("destinatário não comprovado ⇒ NAO_CLAIMADO com ZERO SQL mutável e ZERO provider", async () => {
    const provider = new ProvedorFakeCampanha();
    const resultado = await executeAttemptCampanha(poolQueFalha(), {
      ...ids,
      politica: politicaAberta,
      provas: { recipientProofVerified: false, humanAuthorizationVerified: true },
      provider,
    });
    expect(resultado.resultado).toBe("NAO_CLAIMADO");
    if (resultado.resultado !== "NAO_CLAIMADO") return;
    expect(resultado.claim.resultado).toBe("BLOQUEADO");
    if (resultado.claim.resultado !== "BLOQUEADO") return;
    expect(resultado.claim.bloqueios).toEqual(["PROVA_DESTINATARIO_AUSENTE"]);
    expect(provider.chamadas).toBe(0);
  });

  it("autorização humana ausente ⇒ NAO_CLAIMADO com ZERO SQL mutável e ZERO provider", async () => {
    const provider = new ProvedorFakeCampanha();
    const resultado = await executeAttemptCampanha(poolQueFalha(), {
      ...ids,
      politica: politicaAberta,
      provas: { recipientProofVerified: true, humanAuthorizationVerified: false },
      provider,
    });
    expect(resultado.resultado).toBe("NAO_CLAIMADO");
    if (resultado.resultado !== "NAO_CLAIMADO") return;
    expect(resultado.claim.resultado).toBe("BLOQUEADO");
    if (resultado.claim.resultado !== "BLOQUEADO") return;
    expect(resultado.claim.bloqueios).toEqual(["AUTORIZACAO_HUMANA_AUSENTE"]);
    expect(provider.chamadas).toBe(0);
  });

  it("ambas as provas ausentes ⇒ bloqueios sanitizados acumulados, sem mutação", async () => {
    const provider = new ProvedorFakeCampanha();
    const resultado = await executeAttemptCampanha(poolQueFalha(), {
      ...ids,
      politica: politicaAberta,
      provas: { recipientProofVerified: false, humanAuthorizationVerified: false },
      provider,
    });
    expect(resultado.resultado).toBe("NAO_CLAIMADO");
    if (resultado.resultado !== "NAO_CLAIMADO") return;
    if (resultado.claim.resultado !== "BLOQUEADO") return;
    expect(resultado.claim.bloqueios).toEqual([
      "PROVA_DESTINATARIO_AUSENTE",
      "AUTORIZACAO_HUMANA_AUSENTE",
    ]);
    expect(provider.chamadas).toBe(0);
  });

  it("SLICE_03C.2B1D — versão DRAFT/desconhecida bloqueia ANTES do claim (zero mutação, zero provider)", async () => {
    const provider = new ProvedorFakeCampanha();
    const resultado = await executeAttemptCampanha(poolSentinela(), {
      ...ids,
      politica: politicaAberta,
      provas: provasSinteticas,
      provider,
    });
    expect(resultado.resultado).toBe("NAO_CLAIMADO");
    if (resultado.resultado !== "NAO_CLAIMADO") return;
    expect(resultado.claim.resultado).toBe("BLOQUEADO");
    if (resultado.claim.resultado !== "BLOQUEADO") return;
    expect(resultado.claim.bloqueios).toEqual(["CAMPAIGN_TEMPLATE_UNSUPPORTED"]);
    expect(provider.chamadas).toBe(0);
  });

  it("elegibilidade: flags abertas + ATIVO/PREPARADO NÃO elegem sem CADA prova", () => {
    const estados = {
      loteEstado: "ATIVO",
      itemEstado: "PREPARADO",
      codigoLote: "CAMPANHA_PF_SINTETICA",
    };
    const semDestinatario = avaliarElegibilidadeExecucaoItem({
      politica: politicaAberta,
      ...estados,
      provas: { recipientProofVerified: false, humanAuthorizationVerified: true },
    });
    expect(semDestinatario.elegivel).toBe(false);
    expect(semDestinatario.bloqueios).toEqual(["PROVA_DESTINATARIO_AUSENTE"]);
    const semAutorizacao = avaliarElegibilidadeExecucaoItem({
      politica: politicaAberta,
      ...estados,
      provas: { recipientProofVerified: true, humanAuthorizationVerified: false },
    });
    expect(semAutorizacao.elegivel).toBe(false);
    expect(semAutorizacao.bloqueios).toEqual(["AUTORIZACAO_HUMANA_AUSENTE"]);
  });
});

describe("SLICE_03A.2 — semântica canExecute e superfície (SOURCE_STRUCTURE)", () => {
  it("canExecute é CONFIG_ONLY: doc do tipo não descreve autorização operacional", () => {
    const trecho = FONTE_CAMPAIGNS.slice(
      FONTE_CAMPAIGNS.indexOf("interface PfUpdateCampaignPolicy"),
      FONTE_CAMPAIGNS.indexOf("type Environment"),
    );
    expect(trecho).toContain("canExecute");
    // A doc do tipo NUNCA iguala canExecute a elegibilidade de item real.
    expect(trecho).not.toMatch(/destinat[áa]rio comprovado/i);
    expect(trecho).not.toMatch(/autoriza[çc][ãa]o humana/i);
    // A doc do ENTRYPOINT separa explicitamente as duas semânticas.
    const docEntrypoint = FONTE_EXECUCAO.slice(
      FONTE_EXECUCAO.indexOf("export async function executeAttemptCampanha") - 2600,
      FONTE_EXECUCAO.indexOf("export async function executeAttemptCampanha"),
    );
    expect(docEntrypoint).toContain("CONFIG_ONLY");
  });

  it("provas são pré-condições tipadas obrigatórias do comando e da elegibilidade", () => {
    expect(FONTE_EXECUCAO).toContain("interface ProvasAutorizacaoExecucao");
    expect(FONTE_EXECUCAO).toContain("readonly provas: ProvasAutorizacaoExecucao;");
    const corpoElegibilidade = trechoFuncao(
      FONTE_EXECUCAO,
      "avaliarElegibilidadeExecucaoItem",
    );
    expect(corpoElegibilidade).toContain("PROVA_DESTINATARIO_AUSENTE");
    expect(corpoElegibilidade).toContain("AUTORIZACAO_HUMANA_AUSENTE");
  });

  it("entrypoint fail-closed ANTES de qualquer SQL: gate de provas precede o claim", () => {
    const corpo = FONTE_EXECUCAO.slice(
      FONTE_EXECUCAO.indexOf("export async function executeAttemptCampanha"),
    );
    const gateProvas = corpo.indexOf("PROVA_DESTINATARIO_AUSENTE");
    const primeiroConnect = corpo.indexOf("pool.connect");
    const primeiroClaim = corpo.indexOf("claimItemInterno");
    expect(gateProvas).toBeGreaterThan(-1);
    expect(primeiroConnect).toBeGreaterThan(gateProvas);
    expect(primeiroClaim).toBeGreaterThan(gateProvas);
  });
});

// ---------------------------------------------------------------------------
// Parte 3a — BEHAVIORAL: chave idempotente canônica (anti-concatenação).
// ---------------------------------------------------------------------------

describe("SLICE_03A.1 — chave idempotente canônica (BEHAVIORAL)", () => {
  const entradaBase = {
    campanhaId: "0f0e0d0c-0b0a-49f8-8f7e-6d5c4b3a2f1e",
    loteCampanhaId: "1a1b1c1d-1e1f-4a2b-9c3d-4e5f6a7b8c9d",
    itemId: "2b2c2d2e-2f3a-4b4c-8d5e-6f7a8b9c0d1e",
    destinatarioFingerprint: "aa".repeat(32),
    hashAprovacao: "bb".repeat(32),
  };

  it("determinística e canônica (SHA-256 hex minúsculo)", () => {
    const chave = chaveIdempotenciaExecucao(entradaBase);
    expect(chave).toBe(chaveIdempotenciaExecucao(entradaBase));
    expect(chave).toMatch(/^[0-9a-f]{64}$/);
  });

  it("namespaced: 'PF-CAMP-EXEC-V1' presente no canônico da fonte", () => {
    expect(FONTE_EXECUCAO).toContain("PF-CAMP-EXEC-V1");
    const corpo = trechoFuncao(FONTE_EXECUCAO, "chaveIdempotenciaExecucao");
    expect(corpo).toContain("PF-CAMP-EXEC-V1");
  });

  it("anti-concatenação: separador de unidade entre TODOS os campos no canônico", () => {
    // A fonte serializa campo a campo com separador \u001f + \n terminador.
    const corpo = trechoFuncao(FONTE_EXECUCAO, "chaveIdempotenciaExecucao");
    expect(corpo).toContain("\\u001f");
    // Prova comportamental: campos que concatenariam de forma ambígua
    // (a|bc versus ab|c) produzem chaves DIFERENTES quando ocupam a mesma
    // posição — aqui simulado variando um campo com prefixo do outro.
    const chaveA = chaveIdempotenciaExecucao({
      ...entradaBase,
      destinatarioFingerprint: "a".repeat(63) + "b",
    });
    const chaveB = chaveIdempotenciaExecucao({
      ...entradaBase,
      destinatarioFingerprint: "a".repeat(64),
    });
    expect(chaveA).not.toBe(chaveB);
  });

  it("sensível a CADA componente da identidade do item", () => {
    const chaveReferencia = chaveIdempotenciaExecucao(entradaBase);
    for (const variacao of [
      { campanhaId: randomUUID() },
      { loteCampanhaId: randomUUID() },
      { itemId: randomUUID() },
      { destinatarioFingerprint: "cc".repeat(32) },
      { hashAprovacao: "dd".repeat(32) },
    ] as const) {
      expect(chaveIdempotenciaExecucao({ ...entradaBase, ...variacao })).not.toBe(
        chaveReferencia,
      );
    }
  });

  it("sem PII: a chave nunca deriva de e-mail/nome em claro — apenas fingerprint/hash", () => {
    const chaveComPII = chaveIdempotenciaExecucao({
      ...entradaBase,
      destinatarioFingerprint: createHash("sha256")
        .update("maria.silva@exemplo.gov.br")
        .digest("hex"),
    });
    expect(chaveComPII).toMatch(/^[0-9a-f]{64}$/);
    expect(chaveComPII).not.toContain("maria");
    // A interface tipada não aceita campos de PII (prova de tipo via texto).
    const corpoInterface = FONTE_EXECUCAO.slice(
      FONTE_EXECUCAO.indexOf("interface EntradaChaveIdempotencia"),
      FONTE_EXECUCAO.indexOf("export function chaveIdempotenciaExecucao"),
    );
    expect(corpoInterface).not.toContain("email");
    expect(corpoInterface).not.toContain("nome");
  });
});

// ---------------------------------------------------------------------------
// Parte 3b — SOURCE_STRUCTURE: superfície pública, segregação, zero rede.
// ---------------------------------------------------------------------------

describe("SLICE_03A.1 — provas estruturais de fonte (SOURCE_STRUCTURE)", () => {
  it("entrypoint público ÚNICO: executeAttemptCampanha; claim/provider/receipt internos", () => {
    const exports = FONTE_EXECUCAO.match(/export (function|class|const|interface|type)/g) ?? [];
    const funcoesExportadas = FONTE_EXECUCAO.match(/export (async )?function (\w+)/g) ?? [];
    const nomes = funcoesExportadas.map((f) => f.replace(/export (async )?function /, ""));
    expect(nomes).toEqual([
      "avaliarElegibilidadeExecucaoItem",
      "chaveIdempotenciaExecucao",
      "executeAttemptCampanha",
    ]);
    // Internos NÃO são exportados.
    expect(FONTE_EXECUCAO).not.toMatch(/export .*claimItemInterno/);
    expect(FONTE_EXECUCAO).not.toMatch(/export .*registrarReceiptInterno/);
    expect(FONTE_EXECUCAO).not.toMatch(/export .*terminalizarFalhaInterno/);
    expect(FONTE_EXECUCAO).not.toMatch(/export .*registrarEventoExecucao/);
    expect(exports.length).toBeGreaterThan(0);
  });

  it("provider sem default: ProvedorFakeCampanha nunca é instanciado dentro do módulo", () => {
    expect(FONTE_EXECUCAO).toContain("class ProvedorFakeCampanha");
    expect(FONTE_EXECUCAO).not.toMatch(/new ProvedorFakeCampanha/);
    // executeAttemptCampanha exige provider injetado no comando.
    const corpoEntrypoint = FONTE_EXECUCAO.slice(
      FONTE_EXECUCAO.indexOf("export async function executeAttemptCampanha"),
    );
    expect(corpoEntrypoint).toContain("comando.provider.enviar");
  });

  it("zero rede: sem fetch/http/googleapis/MailGateway/URLs absolutas no módulo", () => {
    expect(FONTE_EXECUCAO).not.toMatch(/https?:\/\//);
    expect(FONTE_EXECUCAO).not.toContain("fetch(");
    expect(FONTE_EXECUCAO).not.toContain("googleapis");
    expect(FONTE_EXECUCAO).not.toContain("MailGateway");
    expect(FONTE_EXECUCAO).not.toContain("http2");
    expect(FONTE_EXECUCAO).not.toContain("net.connect");
    expect(FONTE_EXECUCAO).not.toContain("axios");
  });

  it("segregação do piloto: execução NÃO importa pilot.ts; constante vem do módulo neutro", () => {
    expect(FONTE_EXECUCAO).not.toContain('"./pilot.js"');
    expect(FONTE_EXECUCAO).not.toContain("'./pilot.js'");
    expect(FONTE_EXECUCAO).toContain('from "./pilot-domain.js"');
    // pilot-domain é neutro: sem imports de runtime e valor correto.
    expect(FONTE_PILOT_DOMAIN).not.toMatch(/^import /m);
    expect(FONTE_PILOT_DOMAIN).toContain('RESERVED_PILOT_BATCH_CODE = "CONTROLLED_GMAIL_TEST"');
    // pilot.ts continua consumindo da fonte única (sem duplicar literal).
    expect(FONTE_PILOT).toContain('from "./pilot-domain.js"');
  });

  it("SQL totalmente parametrizado: nenhum $ placeholder interpolado nem template SQL", () => {
    expect(FONTE_EXECUCAO).not.toMatch(/\$\{/);
    const queries = FONTE_EXECUCAO.match(/query\(\s*"[^"]*"/g) ?? [];
    expect(queries.length).toBeGreaterThanOrEqual(6);
    for (const q of queries) {
      // Nenhuma query escrita com aspas simples contendo vírgulas de valor
      // concatenado — todos os valores seguem como array ($1, $2, ...).
      expect(q).not.toMatch(/'\s*\+/);
    }
    // UPDATE/SELECT do claim usam placeholders.
    expect(FONTE_EXECUCAO).toContain("WHERE i.id = $1 AND l.id = $2");
    expect(FONTE_EXECUCAO).toContain("AND l.estado = 'ATIVO' AND i.estado = 'PREPARADO'");
  });

  it("claim exige CAS duplo atômico: lote ATIVO ∧ item PREPARADO no mesmo UPDATE", () => {
    const cas = FONTE_EXECUCAO.slice(
      FONTE_EXECUCAO.indexOf("UPDATE outbox_campanha i SET estado = 'ENFILEIRADO'"),
      FONTE_EXECUCAO.indexOf("UPDATE outbox_campanha i SET estado = 'ENFILEIRADO'") + 400,
    );
    expect(cas).toContain("FROM lote_campanha l");
    expect(cas).toContain("l.estado = 'ATIVO'");
    expect(cas).toContain("i.estado = 'PREPARADO'");
  });

  it("lock de corrida: ordem consistente lote→item (FOR UPDATE OF l, i)", () => {
    expect(FONTE_EXECUCAO).toContain("FOR UPDATE OF l, i");
  });

  it("ambiguidade exige reconciliação HUMANA com auto_retry=false no evento", () => {
    expect(FONTE_EXECUCAO).toContain('reconciliacao: "HUMANA"');
    expect(FONTE_EXECUCAO).toContain("auto_retry: false");
  });

  it("auditoria versionada: esquema EXEC_EVENTO_V1 + nonce de unicidade no metadados", () => {
    expect(FONTE_EXECUCAO).toContain('esquema: "EXEC_EVENTO_V1"');
    expect(FONTE_EXECUCAO).toContain("nonce: randomUUID()");
    // Hash do evento é recomputável (determinístico sobre campos persistidos).
    const corpoHash = trechoFuncao(FONTE_EXECUCAO, "hashEventoExecucao");
    expect(corpoHash).toContain("createHmac");
    expect(FONTE_EXECUCAO).not.toContain("Math.random");
  });

  it("worker produtivo intocado: claimOutbox segue isolado das tabelas da campanha", () => {
    const inicio = FONTE_WORKER.indexOf("async claimOutbox");
    expect(inicio).toBeGreaterThan(0);
    const trecho = FONTE_WORKER.slice(inicio, inicio + 4000);
    expect(trecho).toContain("outbox_email");
    expect(trecho).toContain("lote_comunicacao");
    expect(trecho).toContain("FOR UPDATE SKIP LOCKED");
    expect(trecho).not.toContain("outbox_campanha");
    expect(trecho).not.toContain("lote_campanha");
  });

  it("schema congelado: nenhum ALTER/CREATE/migration no módulo (MIGRATION_REQUIRED=false)", () => {
    expect(FONTE_EXECUCAO).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP /);
  });
});

// ---------------------------------------------------------------------------
// Parte 4 — POSTGRESQL_INTEGRATION (DB-gated, PG16): fixtures 100% sintéticas,
// política INJETADA (nenhuma flag de ambiente é manipulada aqui), corridas de
// verdade com conexões separadas e reconstrução de estado pós-restart.
// Sem DATABASE_URL: PENDING_CI (nunca falsificado como PASS).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Parte 3c — SOURCE_STRUCTURE/BEHAVIORAL: regressão de ARIDADE do binding SQL
// (SLICE_03A.3). Detecta o defeito "bind message supplies N parameters, but
// prepared statement requires M" SEM DATABASE_URL, via executor falso.
// ---------------------------------------------------------------------------

interface ChamadaSql {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** Maior $n do texto. Guarda contra $$ (dollar-quoting) para não falso-positivar. */
function maiorPlaceholder(texto: string): number {
  return texto
    .split("$$")
    .reduce(
      (maior, parte) =>
        Math.max(maior, ...(parte.match(/\$(\d+)/g) ?? []).map((m) => Number(m.slice(1)))),
      0,
    );
}

/**
 * Validador genérico de aridade: aceita reuso legítimo do MESMO placeholder
 * (ex.: $4 em operator_id e ator_operator_id), exige contiguidade $1..$max
 * e igualdade maxPlaceholder === values.length.
 */
function validarAridade(chamada: ChamadaSql): void {
  const usados = chamada.text
    .split("$$")
    .flatMap((parte) => (parte.match(/\$(\d+)/g) ?? []).map((m) => Number(m.slice(1))));
  const max = Math.max(0, ...usados);
  if (max === 0) {
    // Statements de controle (BEGIN/COMMIT/ROLLBACK) não têm placeholders.
    expect(chamada.values.length, "values em statement sem placeholder").toBe(0);
    return;
  }
  expect(max, "max placeholder de: " + chamada.text.slice(0, 80)).toBeGreaterThan(0);
  const distintos = [...new Set(usados)].sort((a, b) => a - b);
  expect(distintos).toEqual(Array.from({ length: max }, (_, i) => i + 1));
  expect(chamada.values.length, "aridade de: " + chamada.text.slice(0, 80)).toBe(max);
}

/**
 * Executor falso que percorre o FLUXO REAL do claim até registrarEventoExecucao
 * (transação: BEGIN → SELECT com lock → CAS com rowCount=1 → evento → COMMIT).
 * Não há DATABASE_URL envolvido: apenas a superfície CampanhaPool/Executor.
 */
function criarExecutorDeAuditoriaSpy(opcoes: { readonly rowCountCas: number }): {
  pool: CampanhaPool;
  chamadas: ChamadaSql[];
} {
  const chamadas: ChamadaSql[] = [];
  const transacao = {
    query: async (text: string, values: readonly unknown[] = []): Promise<{
      rows: readonly any[];
      rowCount: number | null;
    }> => {
      chamadas.push({ text, values });
      if (text.includes("SELECT i.estado")) {
        return {
          rows: [
            {
              item_estado: "PREPARADO",
              destinatario_fingerprint: "aa".repeat(32),
              lote_estado: "ATIVO",
              lote_codigo: "CAMPANHA_PF_SINTETICA",
              hash_aprovacao: "bb".repeat(32),
              operator_id: operadorDoFluxo,
              // SLICE_03C.2B1D / GF-2 FINAL — versão registrada/APPROVED no
              // fake (v2 do registry): as provas D/E validam aridade e fluxo
              // do claim; snapshot estrutural + ordem válida para o preflight.
              template_versao: "pf-expedicao-carteira-2026-v2",
              snapshot_registros: {
                registros: [{ nome: "S", email_normalizado: "s@exemplo.test" }],
              },
              ordem: 1,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("UPDATE outbox_campanha i SET estado")) {
        return { rows: [], rowCount: opcoes.rowCountCas };
      }
      if (text.includes("SELECT destinatario_fingerprint")) {
        return {
          rows: [{ destinatario_fingerprint: "aa".repeat(32) }],
          rowCount: 1,
        };
      }
      if (text.includes("SELECT estado FROM outbox_campanha")) {
        return { rows: [{ estado: "ENFILEIRADO" }], rowCount: 1 };
      }
      if (text.includes("SET estado = 'ENVIADO'")) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("SET estado = 'FALHOU'")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const pool: CampanhaPool = {
    query: async (text, values = []) => {
      chamadas.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
    connect: async () => transacao,
  };
  return { pool, chamadas };
}

const operadorDoFluxo = "9a9b9c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d";

describe("SLICE_03A.3 — aridade e mapeamento SQL (regressão local do binding)", () => {
  const comando = {
    operatorId: operadorDoFluxo,
    campanhaId: "8a8b8c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
    loteCampanhaId: "7b7c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e",
    itemId: "6c6d7e8f-0a1b-4c2d-8e3f-4a5b6c7d8e9f",
    politica: politicaAberta,
    provas: provasSinteticas,
  };

  it("A: $4 reutilizado com quatro valores é aceito pelo validador", () => {
    expect(() =>
      validarAridade({
        text: "UPDATE t SET a = $1, b = $2, c = $3 WHERE operator_id = $4 AND ator = $4",
        values: ["v1", "v2", "v3", "v4"],
      }),
    ).not.toThrow();
  });

  it("B: placeholders até $7 com oito valores é REJEITADO (defeito original reproduzido)", () => {
    expect(() =>
      validarAridade({
        text: "INSERT INTO t VALUES ($1, $2, $3, $4, $4, $5, $6, $7)",
        values: ["v1", "v2", "v3", "v4", "v4", "v5", "v6", "v7"],
      }),
    ).toThrow(/aridade/);
  });

  it("C: placeholders até $7 com sete valores é aceito", () => {
    expect(() =>
      validarAridade({
        text: "INSERT INTO t VALUES ($1, $2, $3, $4, $4, $5, $6, $7)",
        values: ["v1", "v2", "v3", "v4", "v5", "v6", "v7"],
      }),
    ).not.toThrow();
  });

  it("D: fluxo do claim com binding CORRIGIDO — toda query gravada tem aridade válida e INSERT de auditoria mapeado", async () => {
    const { pool, chamadas } = criarExecutorDeAuditoriaSpy({ rowCountCas: 1 });
    const resultado = await executeAttemptCampanha(pool, {
      ...comando,
      provas: provasSinteticas,
      provider: new ProvedorFakeCampanha(),
    });
    expect(resultado.resultado).toBe("ENVIADO");
    expect(chamadas.length).toBeGreaterThan(3);
    for (const chamada of chamadas) validarAridade(chamada);
    const insertAuditoria = chamadas.find((c) =>
      c.text.includes("INSERT INTO evento_auditoria"),
    )!;
    expect(insertAuditoria).toBeDefined();
    // Mapeamento semântico do INSERT (placeholders → valores na posição correta):
    expect(maiorPlaceholder(insertAuditoria.text)).toBe(7);
    expect(insertAuditoria.values.length).toBe(7);
    expect(insertAuditoria.text).toContain("$4, $4");
    expect(insertAuditoria.values[0]).toMatch(/^[0-9a-f-]{36}$/); // id
    expect(insertAuditoria.values[1]).toBe(comando.itemId); // agregado_id
    expect(insertAuditoria.values[2]).toBe("EXEC_CLAIM"); // tipo
    expect(insertAuditoria.values[3]).toBe(operadorDoFluxo); // operator_id/ator
    expect(insertAuditoria.values[4]).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ocorreu_em
    expect(JSON.parse(String(insertAuditoria.values[5])).esquema).toBe("EXEC_EVENTO_V1");
    expect(insertAuditoria.values[6]).toMatch(/^[0-9a-f]{64}$/); // hash_evento
  });

  it("E: ocorreu_em, metadados e hash_evento permanecem em $5/$6/$7 após a correção", async () => {
    const { pool, chamadas } = criarExecutorDeAuditoriaSpy({ rowCountCas: 1 });
    await executeAttemptCampanha(pool, {
      ...comando,
      provas: provasSinteticas,
      provider: new ProvedorFakeCampanha(),
    });
    const insertAuditoria = chamadas.find((c) =>
      c.text.includes("INSERT INTO evento_auditoria"),
    )!;
    expect(insertAuditoria.text).toContain("$4, $4, $5, $6::jsonb, NULL, $7");
    expect(typeof insertAuditoria.values[4]).toBe("string"); // ocorreu_em
    expect(insertAuditoria.values[4]).not.toBe(operadorDoFluxo); // não deslocado
    const metadados = JSON.parse(String(insertAuditoria.values[5]));
    expect(metadados.esquema).toBe("EXEC_EVENTO_V1");
    expect(typeof metadados.nonce).toBe("string");
    expect(insertAuditoria.values[6]).not.toBeNull();
    // Fluxo corrompido (CAS 0 linhas) NÃO grava evento de claim:
    const { pool: poolFalha, chamadas: chamadasFalha } = criarExecutorDeAuditoriaSpy({
      rowCountCas: 0,
    });
    const rejeitado = await executeAttemptCampanha(poolFalha, {
      ...comando,
      provas: provasSinteticas,
      provider: new ProvedorFakeCampanha(),
    });
    expect(rejeitado.resultado).toBe("NAO_CLAIMADO");
    expect(
      chamadasFalha.some(
        (c) => c.text.includes("INSERT INTO evento_auditoria") && c.values[2] === "EXEC_CLAIM",
      ),
    ).toBe(false);
  });

  // GF-3 CORRECTIVE-01 (F5) — SETTLEMENT_ERROR_ROLLBACK: falha no COMMIT da
  // via de settlement (registrarEventoExecucao/COMMIT — aqui exercitada na
  // transação do RECEIPT, mesmo padrão BEGIN → evento → COMMIT do bloco de
  // settlement de executeAttemptCampanha) ⇒ ROLLBACK emitido, conexão liberada
  // SEM transação aberta e causa original preservada. Prova BEHAVIORAL (sem
  // banco) sobre pool falso que percorre o fluxo REAL.
  it("F: falha no COMMIT da via de settlement (receipt) ⇒ ROLLBACK + release + causa original (conexão não volta com transação aberta)", async () => {
    const chamadas: ChamadaSql[] = [];
    const liberada: boolean[] = [];
    const falhaCommit = new Error("commit settlement falhou (sintético)");
    const transacao = {
      query: async (text: string): Promise<{ rows: readonly unknown[]; rowCount: number | null }> => {
        chamadas.push({ text, values: [] });
        if (text.includes("SELECT i.estado") && text.includes("template_versao") && text.includes("snapshot_registros")) {
          return {
            rows: [
              {
                item_estado: "PREPARADO",
                destinatario_fingerprint: "aa".repeat(32),
                lote_estado: "ATIVO",
                lote_codigo: "EXEC_LOTE_SINTETICO",
                hash_aprovacao: "bb".repeat(32),
                operator_id: operadorDoFluxo,
                template_versao: "pf-expedicao-carteira-2026-v2",
                snapshot_registros: {
                  template_versao: "pf-expedicao-carteira-2026-v2",
                  template_content_hash: "cc".repeat(32),
                  approval_hash_version: "CAMPANHA_APROVACAO_V2",
                  registros: [
                    {
                      profissional_id: "00000000-0000-4000-8000-000000000001",
                      nome: "Profissional Sintetico",
                      email_normalizado: "prof.settlement@exemplo.test",
                      status_validacao: "APTO",
                    },
                  ],
                },
                ordem: 1,
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes("SELECT destinatario_fingerprint FROM outbox_campanha WHERE id")) {
          return { rows: [{ destinatario_fingerprint: "aa".repeat(32) }], rowCount: 1 };
        }
        if (text.includes("SELECT estado FROM outbox_campanha")) {
          // registrarReceiptInterno: item ENFILEIRADO segue para receipt+CAS.
          return { rows: [{ estado: "ENFILEIRADO" }], rowCount: 1 };
        }
        if (text === "COMMIT" && chamadas.filter((c) => c.text === "COMMIT").length > 2) {
          // Terceiro COMMIT = transação de settlement (1º = claim, 2º =
          // EXEC_TENTATIVA_INICIADA) ⇒ falha sintética exatamente lá.
          throw falhaCommit;
        }
        return { rows: [], rowCount: 1 };
      },
      release: (): void => {
        liberada.push(true);
      },
    };
    const pool: CampanhaPool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => transacao,
    };
    await expect(
      executeAttemptCampanha(pool, {
        ...comando,
        provas: provasSinteticas,
        provider: new ProvedorFakeCampanha(),
      }),
    ).rejects.toBe(falhaCommit); // causa original preservada (sem mascarar)
    // BEGIN → ... → COMMIT (claim, ok) → BEGIN (settlement) → evento →
    // COMMIT falha → ROLLBACK (settlement) — a conexão foi liberada exatamente
    // uma vez por transação (claim + tentativa + settlement) e o último
    // statement da transação com falha é ROLLBACK, nunca COMMIT pendente.
    // A transação que falhou no COMMIT é a do RECEIPT (registrarReceiptInterno
    // — mesmo padrão BEGIN → evento → COMMIT): ROLLBACK foi emitido, a conexão
    // foi liberada e a settlement NUNCA iniciou (a causa propagou antes).
    const indiceBeginRecebimento = chamadas.map((c) => c.text).lastIndexOf("BEGIN");
    const aposBegin = chamadas.slice(indiceBeginRecebimento).map((c) => c.text);
    expect(aposBegin.some((t) => t.includes("INSERT INTO evento_auditoria"))).toBe(true);
    expect(aposBegin[aposBegin.length - 1]).toBe("ROLLBACK");
    // 3 conexões usadas (claim, tentativa, receipt-falho); 3 COMMITs emitidos
    // (claim + tentativa OK; o 3º, do receipt, FALHOU) e 1 ROLLBACK da
    // transação quebrada — a conexão não volta ao pool com transação aberta.
    expect(liberada.length).toBe(3);
    expect(chamadas.filter((c) => c.text === "COMMIT").length).toBe(3);
    expect(chamadas.filter((c) => c.text === "ROLLBACK").length).toBe(1);
  });

  it("fonte do módulo: array de valores do INSERT de auditoria tem exatamente 7 elementos", () => {
    const inicio = FONTE_EXECUCAO.indexOf("INSERT INTO evento_auditoria");
    const trecho = FONTE_EXECUCAO.slice(inicio, FONTE_EXECUCAO.indexOf("],", inicio));
    // itemId, tipo, operatorId, agora (4) + itemId, tipo, agora dentro do hash (3)
    expect((trecho.match(/entrada\./g) ?? []).length).toBe(7);
    expect(trecho).toContain("randomUUID()");
    // Nenhum operatorId duplicado no array:
    const indicePrimeiro = trecho.indexOf("entrada.operatorId");
    expect(trecho.indexOf("entrada.operatorId", indicePrimeiro + 1)).toBe(-1);
  });
});

const describeDb = DB_URL_AMBIENTE ? describe : describe.skip;

type PoolTipado = import("@integra-correios/persistence").NodePostgresPool;
type ProviderTipado = Parameters<typeof executeAttemptCampanha>[1]["provider"];

function executar(
  pool: PoolTipado,
  provider: ProviderTipado,
  ids: {
    readonly operatorId: string;
    readonly campanhaId: string;
    readonly loteCampanhaId: string;
    readonly itemId: string;
  },
): ReturnType<typeof executeAttemptCampanha> {
  return executeAttemptCampanha(pool, {
    ...ids,
    politica: politicaAberta,
    provas: provasSinteticas,
    provider,
  });
}

async function estadoDoItem(pool: PoolTipado, itemId: string): Promise<string | null> {
  const linhas = await pool.query(
    "SELECT estado FROM outbox_campanha WHERE id = $1",
    [itemId],
  );
  return (linhas.rows[0] as { estado: string } | undefined)?.estado ?? null;
}

async function contarEventos(
  pool: PoolTipado,
  itemId: string,
  tipo: string,
): Promise<number> {
  const linhas = await pool.query(
    "SELECT count(*)::int AS total FROM evento_auditoria WHERE agregado_id = $1 AND tipo = $2",
    [itemId, tipo],
  );
  return (linhas.rows[0] as { total: number }).total;
}

async function criarOperadorSintetico(
  pool: PoolTipado,
  operadorId: string,
  prefixo: string,
): Promise<void> {
  const agora = new Date().toISOString();
  await pool.query(
    "INSERT INTO operador (id, codigo, nome_exibicao, status, criado_em, atualizado_em) VALUES ($1, $2, $3, 'ATIVO', $4, $4)",
    [operadorId, prefixo + "-" + operadorId.replace(/-/g, "").slice(0, 10), "Operador Sintetico Exec", agora],
  );
}

interface CenaLote {
  readonly campanhaId: string;
  readonly loteCampanhaId: string;
  readonly hashAprovacao: string;
  readonly templateContentHash: string;
  readonly registros: readonly RegistroFixtureCampanha[];
}

interface RegistroFixtureCampanha {
  readonly profissional_id: string;
  readonly nome: string;
  readonly email_normalizado: string;
  readonly status_validacao: string;
}

const TEMPLATE_V2_FIXTURE = TEMPLATE_V2_VERSION;

/**
 * GF-2 CI CORRECTIVE-01 — snapshot V2 GOVERNADO da fixture (fonte única,
 * usada pelo builder de cena e pela prova independente): contentHash obtido
 * da entrada APPROVED do registry (nunca literal duplicado), marcador
 * approval_hash_version, um registro sintético POR ORDEM (registro do item =
 * registros[ordem - 1]) e hash de aprovação V2 recalculado pelo helper
 * canônico sobre EXATAMENTE o snapshot persistido. 100% sintético (.test,
 * UUIDs sintéticos, sem PII).
 */
function cenarioV2Sintetico(quantidade: number): {
  readonly registros: readonly RegistroFixtureCampanha[];
  readonly templateContentHash: string;
  readonly snapshot: {
    readonly template_versao: string;
    readonly template_content_hash: string;
    readonly approval_hash_version: "CAMPANHA_APROVACAO_V2";
    readonly registros: readonly RegistroFixtureCampanha[];
  };
  readonly hashAprovacao: string;
} {
  const templateContentHash = contentHashDoTemplate(TEMPLATE_V2_FIXTURE);
  if (!templateContentHash) {
    throw new Error("Fixture: registry v2 sem contentHash canônico.");
  }
  const registros: RegistroFixtureCampanha[] = Array.from({ length: quantidade }, (_, indice) => ({
    profissional_id: `00000000-0000-4000-8000-${String(indice + 1).padStart(12, "0")}`,
    nome: `Profissional Sintetico Exec ${indice + 1}`,
    email_normalizado: `prof.exec.fixture.${indice + 1}@exemplo.test`,
    status_validacao: "APTO",
  }));
  const snapshot = {
    template_versao: TEMPLATE_V2_FIXTURE,
    template_content_hash: templateContentHash,
    approval_hash_version: "CAMPANHA_APROVACAO_V2" as const,
    registros,
  };
  // Helper público/canônico (contrato V2) sobre o snapshot EXATO persistido.
  const hashAprovacao = hashAprovacaoCampanha({
    contrato: "CAMPANHA_APROVACAO_V2",
    templateVersao: TEMPLATE_V2_FIXTURE,
    templateContentHash,
    registros,
  });
  return { registros, templateContentHash, snapshot, hashAprovacao };
}

/** Campanha + lote + itens sintéticos (UNIQUE por execução; NUNCA dados reais). */
async function criarCenaLote(
  pool: PoolTipado,
  params: {
    readonly operatorId: string;
    readonly estadoLote: string;
    readonly codigoLote?: string;
    readonly itens: readonly { readonly id: string; readonly estado: string }[];
  },
): Promise<CenaLote> {
  const campanhaId = randomUUID();
  const loteCampanhaId = randomUUID();
  const agora = new Date().toISOString();
  const cenario = cenarioV2Sintetico(params.itens.length);
  const fingerprintArquivo = createHash("sha256").update("exec-fixture-" + campanhaId).digest("hex");
  await pool.query(
    "INSERT INTO campanha_persistida (id, operator_id, fingerprint_arquivo, template_versao, hash_aprovacao, snapshot_registros, total_registros, total_aptos, total_bloqueados, total_aprovados, estado, criada_em, atualizada_em) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 0, $8, 'LOTE_CRIADO', $9, $9)",
    [
      campanhaId,
      params.operatorId,
      fingerprintArquivo,
      cenario.snapshot.template_versao,
      cenario.hashAprovacao,
      JSON.stringify(cenario.snapshot),
      cenario.registros.length,
      cenario.registros.length,
      agora,
    ],
  );
  await pool.query(
    "INSERT INTO lote_campanha (id, campanha_id, origem, codigo, template_versao, estado, total_itens, criado_em) VALUES ($1, $2, 'PF', $3, $4, $5, $6, $7)",
    [loteCampanhaId, campanhaId, params.codigoLote ?? "EXEC_LOTE_SINTETICO", TEMPLATE_V2_FIXTURE, params.estadoLote, params.itens.length, agora],
  );
  let ordem = 0;
  for (const item of params.itens) {
    ordem += 1;
    // Resolução EXATA do contrato: registro do item = registros[ordem - 1];
    // destinatario_fingerprint canônico do e-mail normalizado do registro.
    const registro = cenario.registros[ordem - 1]!;
    await pool.query(
      "INSERT INTO outbox_campanha (id, lote_campanha_id, ordem, destinatario_fingerprint, payload_snapshot, estado, criada_em) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)",
      [
        item.id,
        loteCampanhaId,
        ordem,
        fingerprintDestinatarioCampanha(registro.email_normalizado),
        JSON.stringify({ template_versao: TEMPLATE_V2_FIXTURE, template_content_hash: cenario.templateContentHash, ordem }),
        item.estado,
        agora,
      ],
    );
  }
  return { campanhaId, loteCampanhaId, hashAprovacao: cenario.hashAprovacao, templateContentHash: cenario.templateContentHash, registros: cenario.registros };
}

/**
 * GF-2 CI CORRECTIVE-01 — prova INDEPENDENTE do preflight de execução
 * (FIXTURE_VALIDATION_INDEPENDENT): as asserções abaixo usam APENAS o
 * registry público (metadados/contentHash) e o helper canônico do hash para
 * CONSTRUIR a fixture — nunca o verificador de snapshot da execução.
 */
describe("SLICE_03A.1 — fixture V2 governada (prova independente do preflight)", () => {
  const cenario = cenarioV2Sintetico(5);

  it("EXEC_FIXTURE_TEMPLATE_APPROVED: v2 registrada e APPROVED no registry público", () => {
    const meta = metadadosTemplate(TEMPLATE_V2_FIXTURE);
    expect(meta.ok).toBe(true);
    if (!meta.ok) return expect.unreachable();
    expect(meta.status).toBe("APPROVED");
    expect(meta.scope).toBe("PF_CAMPAIGN");
    expect(meta.dataMode).toBe("PREFILLED_CONFIRMATION");
  });

  it("EXEC_FIXTURE_CONTENT_HASH_MATCH: contentHash da fixture = contentHash canônico do registry", () => {
    expect(cenario.templateContentHash).toBe(contentHashDoTemplate(TEMPLATE_V2_FIXTURE));
    expect(cenario.snapshot.template_content_hash).toBe(cenario.templateContentHash);
  });

  it("EXEC_FIXTURE_VALID_V2_SNAPSHOT: versão/marcador/tamanho/ordem coerentes e sintéticos", () => {
    expect(cenario.snapshot.template_versao).toBe(TEMPLATE_V2_FIXTURE);
    expect(cenario.snapshot.approval_hash_version).toBe("CAMPANHA_APROVACAO_V2");
    expect(cenario.snapshot.registros.length).toBe(5);
    for (const registro of cenario.snapshot.registros) {
      expect(registro.status_validacao).toBe("APTO");
      expect(registro.email_normalizado.endsWith(".test")).toBe(true);
      expect(registro.profissional_id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("EXEC_FIXTURE_APPROVAL_HASH_MATCH: hash V2 recalculado sobre o snapshot = hash persistido", () => {
    expect(cenario.hashAprovacao).toMatch(/^[0-9a-f]{64}$/);
    expect(cenario.hashAprovacao).toBe(
      hashAprovacaoCampanha({
        contrato: "CAMPANHA_APROVACAO_V2",
        templateVersao: cenario.snapshot.template_versao,
        templateContentHash: cenario.snapshot.template_content_hash,
        registros: cenario.snapshot.registros,
      }),
    );
  });

  it("EXEC_FIXTURE_ORDER_RESOLVES_RECORD + EXEC_FIXTURE_RECIPIENT_FP_MATCH: item da ordem N resolve registros[N-1] com fingerprint canônico", () => {
    for (let ordem = 1; ordem <= 5; ordem += 1) {
      const registro = cenario.snapshot.registros[ordem - 1]!;
      expect(registro.email_normalizado).toBe(`prof.exec.fixture.${ordem}@exemplo.test`);
      expect(fingerprintDestinatarioCampanha(registro.email_normalizado)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
})

describeDb("SLICE_03A.1 — jornada e gates (POSTGRESQL_INTEGRATION)", () => {
  let pool: PoolTipado | undefined;
  const operadorId = randomUUID();
  const itemOkId = randomUUID();
  const itemHoldId = randomUUID();
  const itemEnfileiradoId = randomUUID();
  const itemFalhouId = randomUUID();
  const itemCanceladoId = randomUUID();
  let cenaAtiva: CenaLote;
  let cenaLoteHold: CenaLote;
  let cenaLoteCancelado: CenaLote;
  let cenaLotePreparado: CenaLote;

  beforeAll(async () => {
    const { NodePostgresPool } = await import("@integra-correios/persistence");
    pool = new NodePostgresPool({ connectionString: DB_URL_AMBIENTE!, max: 4 });
    await criarOperadorSintetico(pool, operadorId, "EXEC-A");
    cenaAtiva = await criarCenaLote(pool, {
      operatorId: operadorId,
      estadoLote: "ATIVO",
      itens: [
        { id: itemOkId, estado: "PREPARADO" },
        { id: itemHoldId, estado: "HOLD" },
        { id: itemEnfileiradoId, estado: "ENFILEIRADO" },
        { id: itemFalhouId, estado: "FALHOU" },
        { id: itemCanceladoId, estado: "CANCELADO" },
      ],
    });
    cenaLoteHold = await criarCenaLote(pool, {
      operatorId: operadorId,
      estadoLote: "HOLD",
      itens: [{ id: randomUUID(), estado: "PREPARADO" }],
    });
    cenaLoteCancelado = await criarCenaLote(pool, {
      operatorId: operadorId,
      estadoLote: "CANCELADO",
      itens: [{ id: randomUUID(), estado: "PREPARADO" }],
    });
    cenaLotePreparado = await criarCenaLote(pool, {
      operatorId: operadorId,
      estadoLote: "PREPARADO",
      itens: [{ id: randomUUID(), estado: "PREPARADO" }],
    });
  });

  afterAll(async () => {
    await pool?.close();
  });

  it("fluxo completo: claim CAS → provider injetado → receipt → settlement exatamente uma vez", async () => {
    const provider = new ProvedorFakeCampanha();
    const resultado = await executar(pool!, provider, {
      operatorId: operadorId,
      campanhaId: cenaAtiva.campanhaId,
      loteCampanhaId: cenaAtiva.loteCampanhaId,
      itemId: itemOkId,
    });
    expect(resultado.resultado).toBe("ENVIADO");
    expect(provider.chamadas).toBe(1);
    expect(await estadoDoItem(pool!, itemOkId)).toBe("ENVIADO");
    expect(await contarEventos(pool!, itemOkId, "EXEC_CLAIM")).toBe(1);
    expect(await contarEventos(pool!, itemOkId, "EXEC_TENTATIVA_INICIADA")).toBe(1);
    expect(await contarEventos(pool!, itemOkId, "EXEC_RECEIPT")).toBe(1);
    expect(await contarEventos(pool!, itemOkId, "EXEC_SETTLEMENT")).toBe(1);
  });

  it("repetição pós-settlement: NAO_CLAIMADO/JA_CONCLUIDO, chave idempotente reconstruída do DB", async () => {
    const provider = new ProvedorFakeCampanha();
    const repeticao = await executar(pool!, provider, {
      operatorId: operadorId,
      campanhaId: cenaAtiva.campanhaId,
      loteCampanhaId: cenaAtiva.loteCampanhaId,
      itemId: itemOkId,
    });
    expect(repeticao.resultado).toBe("NAO_CLAIMADO");
    if (repeticao.resultado !== "NAO_CLAIMADO") return;
    expect(repeticao.claim.resultado).toBe("JA_CONCLUIDO");
    if (repeticao.claim.resultado !== "JA_CONCLUIDO") return;
    expect(repeticao.claim.estado).toBe("ENVIADO");
    expect(provider.chamadas).toBe(0);
    // A chave devolvida é EXATAMENTE a canônica derivada do estado persistido.
    const linhas = await pool!.query(
      "SELECT destinatario_fingerprint FROM outbox_campanha WHERE id = $1",
      [itemOkId],
    );
    const fingerprint = (linhas.rows[0] as { destinatario_fingerprint: string })
      .destinatario_fingerprint;
    expect(repeticao.claim.chaveIdempotencia).toBe(
      chaveIdempotenciaExecucao({
        campanhaId: cenaAtiva.campanhaId,
        loteCampanhaId: cenaAtiva.loteCampanhaId,
        itemId: itemOkId,
        destinatarioFingerprint: fingerprint,
        hashAprovacao: cenaAtiva.hashAprovacao,
      }),
    );
    expect(await contarEventos(pool!, itemOkId, "EXEC_RECEIPT")).toBe(1);
  });

  it("item HOLD em lote ATIVO: BLOQUEADO ITEM_NAO_PREPARADO, zero mutação, evento de rejeição", async () => {
    const provider = new ProvedorFakeCampanha();
    const resultado = await executar(pool!, provider, {
      operatorId: operadorId,
      campanhaId: cenaAtiva.campanhaId,
      loteCampanhaId: cenaAtiva.loteCampanhaId,
      itemId: itemHoldId,
    });
    expect(resultado.resultado).toBe("NAO_CLAIMADO");
    if (resultado.resultado !== "NAO_CLAIMADO") return;
    expect(resultado.claim.resultado).toBe("BLOQUEADO");
    if (resultado.claim.resultado !== "BLOQUEADO") return;
    expect(resultado.claim.bloqueios).toEqual(["ITEM_NAO_PREPARADO"]);
    expect(provider.chamadas).toBe(0);
    expect(await estadoDoItem(pool!, itemHoldId)).toBe("HOLD");
    expect(await contarEventos(pool!, itemHoldId, "EXEC_CLAIM_REJEITADO")).toBe(1);
    expect(await contarEventos(pool!, itemHoldId, "EXEC_CLAIM")).toBe(0);
  });

  it("crash-boundary A: item ENFILEIRADO NUNCA é recapturado (reconciliação humana)", async () => {
    const provider = new ProvedorFakeCampanha();
    const resultado = await executar(pool!, provider, {
      operatorId: operadorId,
      campanhaId: cenaAtiva.campanhaId,
      loteCampanhaId: cenaAtiva.loteCampanhaId,
      itemId: itemEnfileiradoId,
    });
    expect(resultado.resultado).toBe("NAO_CLAIMADO");
    if (resultado.resultado !== "NAO_CLAIMADO") return;
    expect(resultado.claim.resultado).toBe("BLOQUEADO");
    expect(provider.chamadas).toBe(0);
    expect(await estadoDoItem(pool!, itemEnfileiradoId)).toBe("ENFILEIRADO");
  });

  it("itens terminais FALHOU e CANCELADO devolvem JA_CONCLUIDO com o estado persistido", async () => {
    const provider = new ProvedorFakeCampanha();
    for (const [itemId, estado] of [
      [itemFalhouId, "FALHOU"],
      [itemCanceladoId, "CANCELADO"],
    ] as const) {
      const resultado = await executar(pool!, provider, {
        operatorId: operadorId,
        campanhaId: cenaAtiva.campanhaId,
        loteCampanhaId: cenaAtiva.loteCampanhaId,
        itemId,
      });
      expect(resultado.resultado).toBe("NAO_CLAIMADO");
      if (resultado.resultado !== "NAO_CLAIMADO") return;
      expect(resultado.claim.resultado).toBe("JA_CONCLUIDO");
      if (resultado.claim.resultado !== "JA_CONCLUIDO") return;
      expect(resultado.claim.estado).toBe(estado);
    }
    expect(provider.chamadas).toBe(0);
  });

  it("lotes HOLD / CANCELADO / PREPARADO: execução negada pelo estado do lote", async () => {
    const provider = new ProvedorFakeCampanha();
    const itens = [
      { cena: cenaLoteHold, label: "HOLD" },
      { cena: cenaLoteCancelado, label: "CANCELADO" },
      { cena: cenaLotePreparado, label: "PREPARADO" },
    ];
    for (const { cena, label } of itens) {
      const itemAlvo = (await pool!.query(
        "SELECT id FROM outbox_campanha WHERE lote_campanha_id = $1 AND estado = 'PREPARADO' LIMIT 1",
        [cena.loteCampanhaId],
      )).rows[0] as { id: string };
      const resultado = await executar(pool!, provider, {
        operatorId: operadorId,
        campanhaId: cena.campanhaId,
        loteCampanhaId: cena.loteCampanhaId,
        itemId: itemAlvo.id,
      });
      expect(resultado.resultado, "lote " + label).toBe("NAO_CLAIMADO");
      if (resultado.resultado !== "NAO_CLAIMADO") return;
      expect(resultado.claim.resultado, "lote " + label).toBe("BLOQUEADO");
      if (resultado.claim.resultado !== "BLOQUEADO") return;
      expect(resultado.claim.bloqueios, "lote " + label).toContain("LOTE_NAO_ATIVO");
      expect(await estadoDoItem(pool!, itemAlvo.id), "lote " + label).toBe("PREPARADO");
    }
    expect(provider.chamadas).toBe(0);
  });

  it("ownership server-side: operador estranho → NAO_ENCONTRADO, zero mutação, zero evento", async () => {
    const provider = new ProvedorFakeCampanha();
    const resultado = await executar(pool!, provider, {
      operatorId: randomUUID(),
      campanhaId: cenaAtiva.campanhaId,
      loteCampanhaId: cenaAtiva.loteCampanhaId,
      itemId: itemOkId,
    });
    expect(resultado.resultado).toBe("NAO_CLAIMADO");
    if (resultado.resultado !== "NAO_CLAIMADO") return;
    expect(resultado.claim.resultado).toBe("NAO_ENCONTRADO");
    expect(provider.chamadas).toBe(0);
    expect(await estadoDoItem(pool!, itemOkId)).toBe("ENVIADO");
    expect(await contarEventos(pool!, itemOkId, "EXEC_CLAIM_REJEITADO")).toBe(0);
  });

  it("entrada inválida (UUID malformado) é rejeitada antes de tocar o banco", async () => {
    const provider = new ProvedorFakeCampanha();
    await expect(
      executar(pool!, provider, {
        operatorId: operadorId,
        campanhaId: cenaAtiva.campanhaId,
        loteCampanhaId: cenaAtiva.loteCampanhaId,
        itemId: "nao-e-uuid",
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    expect(provider.chamadas).toBe(0);
  });

  it("auditoria sanitizada e versionada: EXEC_EVENTO_V1 + nonce + sem PII em cada evento", async () => {
    const eventos = await pool!.query(
      "SELECT tipo, metadados FROM evento_auditoria WHERE agregado_id = $1 AND agregado_tipo = 'CAMPANHA_EXECUCAO' ORDER BY sequencia",
      [itemOkId],
    );
    const linhas = eventos.rows as { tipo: string; metadados: Record<string, unknown> }[];
    for (const evento of linhas) {
      expect(evento.metadados.esquema).toBe("EXEC_EVENTO_V1");
      expect(typeof evento.metadados.nonce).toBe("string");
      const serializado = JSON.stringify(evento.metadados);
      expect(serializado).not.toContain("email_normalizado");
      expect(serializado).not.toContain("@");
    }
    expect(linhas.map((e) => e.tipo)).toEqual([
      "EXEC_CLAIM",
      "EXEC_TENTATIVA_INICIADA",
      "EXEC_RECEIPT",
      "EXEC_SETTLEMENT",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Parte 5 — POSTGRESQL_INTEGRATION: corridas com conexões separadas, classes
// de falha, corrida de cancelamento do lote e reconstrução pós-restart.
// ---------------------------------------------------------------------------

describeDb("SLICE_03A.1 — corridas, falhas e restart (POSTGRESQL_INTEGRATION)", () => {
  let pool: PoolTipado | undefined;
  const operadorId = randomUUID();
  let cenaFalhas: CenaLote;
  let cenaConcorrencia: CenaLote;
  let cenaCancelamento: CenaLote;
  const itemAmbiguoId = randomUUID();
  const itemPreProviderId = randomUUID();
  const itemDefinitivaId = randomUUID();
  const itemCorridaId = randomUUID();

  beforeAll(async () => {
    const { NodePostgresPool } = await import("@integra-correios/persistence");
    pool = new NodePostgresPool({ connectionString: DB_URL_AMBIENTE!, max: 4 });
    await criarOperadorSintetico(pool, operadorId, "EXEC-B");
    cenaFalhas = await criarCenaLote(pool, {
      operatorId: operadorId,
      estadoLote: "ATIVO",
      itens: [
        { id: itemAmbiguoId, estado: "PREPARADO" },
        { id: itemPreProviderId, estado: "PREPARADO" },
        { id: itemDefinitivaId, estado: "PREPARADO" },
      ],
    });
    cenaConcorrencia = await criarCenaLote(pool, {
      operatorId: operadorId,
      estadoLote: "ATIVO",
      itens: [{ id: itemCorridaId, estado: "PREPARADO" }],
    });
    cenaCancelamento = await criarCenaLote(pool, {
      operatorId: operadorId,
      estadoLote: "ATIVO",
      itens: [{ id: randomUUID(), estado: "PREPARADO" }],
    });
  });

  afterAll(async () => {
    await pool?.close();
  });

  it("AMBIGUO: FALHOU com reconciliacao=HUMANA e auto_retry=false; NUNCA falso ENVIADO", async () => {
    const provider = new ProvedorFakeCampanha([{ tipo: "AMBIGUO" }]);
    const resultado = await executar(pool!, provider, {
      operatorId: operadorId,
      campanhaId: cenaFalhas.campanhaId,
      loteCampanhaId: cenaFalhas.loteCampanhaId,
      itemId: itemAmbiguoId,
    });
    expect(resultado.resultado).toBe("AMBIGUO");
    expect(provider.chamadas).toBe(1);
    expect(await estadoDoItem(pool!, itemAmbiguoId)).toBe("FALHOU");
    const eventos = await pool!.query(
      "SELECT metadados FROM evento_auditoria WHERE agregado_id = $1 AND tipo = 'EXEC_AMBIGUO'",
      [itemAmbiguoId],
    );
    const metadados = (eventos.rows[0] as { metadados: Record<string, unknown> }).metadados;
    expect(metadados.reconciliacao).toBe("HUMANA");
    expect(metadados.auto_retry).toBe(false);
    expect(await contarEventos(pool!, itemAmbiguoId, "EXEC_RECEIPT")).toBe(0);
    // Sem retry automático: nova tentativa NÃO re-clama item terminal.
    const segunda = await executar(pool!, provider, {
      operatorId: operadorId,
      campanhaId: cenaFalhas.campanhaId,
      loteCampanhaId: cenaFalhas.loteCampanhaId,
      itemId: itemAmbiguoId,
    });
    expect(segunda.resultado).toBe("NAO_CLAIMADO");
    expect(provider.chamadas).toBe(1);
  });

  it("FALHA_PRE_PROVIDER: FALHOU sem receipt (nunca houve aceite externo)", async () => {
    const provider = new ProvedorFakeCampanha([{ tipo: "FALHA_PRE_PROVIDER" }]);
    const resultado = await executar(pool!, provider, {
      operatorId: operadorId,
      campanhaId: cenaFalhas.campanhaId,
      loteCampanhaId: cenaFalhas.loteCampanhaId,
      itemId: itemPreProviderId,
    });
    expect(resultado.resultado).toBe("FALHA_PRE_PROVIDER");
    expect(await estadoDoItem(pool!, itemPreProviderId)).toBe("FALHOU");
    expect(await contarEventos(pool!, itemPreProviderId, "EXEC_RECEIPT")).toBe(0);
    expect(await contarEventos(pool!, itemPreProviderId, "EXEC_FALHA_PRE_PROVIDER")).toBe(1);
    const eventos = await pool!.query(
      "SELECT metadados FROM evento_auditoria WHERE agregado_id = $1 AND tipo = 'EXEC_FALHA_PRE_PROVIDER'",
      [itemPreProviderId],
    );
    expect((eventos.rows[0] as { metadados: Record<string, unknown> }).metadados.classe).toBe(
      "PRE_PROVIDER",
    );
  });

  it("FALHA_DEFINITIVA: FALHOU com classe definitiva no evento de auditoria", async () => {
    const provider = new ProvedorFakeCampanha([{ tipo: "FALHA_DEFINITIVA" }]);
    const resultado = await executar(pool!, provider, {
      operatorId: operadorId,
      campanhaId: cenaFalhas.campanhaId,
      loteCampanhaId: cenaFalhas.loteCampanhaId,
      itemId: itemDefinitivaId,
    });
    expect(resultado.resultado).toBe("FALHA_DEFINITIVA");
    expect(await estadoDoItem(pool!, itemDefinitivaId)).toBe("FALHOU");
    expect(await contarEventos(pool!, itemDefinitivaId, "EXEC_RECEIPT")).toBe(0);
    expect(await contarEventos(pool!, itemDefinitivaId, "EXEC_FALHA_DEFINITIVA")).toBe(1);
  });

  it("corrida do claim: 2 POOLS separados — exatamente 1 vencedor; o perdedor observa ENFILEIRADO (BLOQUEADO) ou ENVIADO (JA_CONCLUIDO) conforme o interleaving", async () => {
    const { NodePostgresPool } = await import("@integra-correios/persistence");
    const poolB = new NodePostgresPool({ connectionString: DB_URL_AMBIENTE!, max: 2 });
    try {
      const providerA = new ProvedorFakeCampanha();
      const providerB = new ProvedorFakeCampanha();
      const comando = {
        operatorId: operadorId,
        campanhaId: cenaConcorrencia.campanhaId,
        loteCampanhaId: cenaConcorrencia.loteCampanhaId,
        itemId: itemCorridaId,
      };
      const [a, b] = await Promise.all([
        executar(pool!, providerA, comando),
        executar(poolB, providerB, comando),
      ]);
      // Invariantes globais válidos para AMBOS os ordenamentos reais:
      const enviados = [a, b].filter((r) => r.resultado === "ENVIADO");
      const naoClaimados = [a, b].filter((r) => r.resultado === "NAO_CLAIMADO");
      expect(enviados.length).toBe(1);
      expect(naoClaimados.length).toBe(1);
      expect(providerA.chamadas + providerB.chamadas).toBe(1);
      expect(await estadoDoItem(pool!, itemCorridaId)).toBe("ENVIADO");
      expect(await contarEventos(pool!, itemCorridaId, "EXEC_CLAIM")).toBe(1);
      expect(await contarEventos(pool!, itemCorridaId, "EXEC_TENTATIVA_INICIADA")).toBe(1);
      expect(await contarEventos(pool!, itemCorridaId, "EXEC_RECEIPT")).toBe(1);
      expect(await contarEventos(pool!, itemCorridaId, "EXEC_SETTLEMENT")).toBe(1);
      expect(await contarEventos(pool!, itemCorridaId, "EXEC_FALHA_PRE_PROVIDER")).toBe(0);
      expect(await contarEventos(pool!, itemCorridaId, "EXEC_FALHA_DEFINITIVA")).toBe(0);
      expect(await contarEventos(pool!, itemCorridaId, "EXEC_AMBIGUO")).toBe(0);
      const vencedor = a.resultado === "ENVIADO" ? a : b;
      const perdedor = a.resultado === "ENVIADO" ? b : a;
      const providerPerdedor = vencedor === a ? providerB : providerA;
      expect(perdedor.resultado).toBe("NAO_CLAIMADO");
      if (perdedor.resultado !== "NAO_CLAIMADO") return;
      // Contrato do perdedor: SOMENTE os dois desfechos seguros. CLAIMADO,
      // NAO_ENCONTRADO ou qualquer outro resultado é rejeitado.
      if (
        perdedor.claim.resultado !== "BLOQUEADO" &&
        perdedor.claim.resultado !== "JA_CONCLUIDO"
      ) {
        throw new Error("desfecho inseguro do perdedor: " + perdedor.claim.resultado);
      }
      expect(providerPerdedor.chamadas).toBe(0);
      const rejeitados = await contarEventos(pool!, itemCorridaId, "EXEC_CLAIM_REJEITADO");
      if (perdedor.claim.resultado === "BLOQUEADO") {
        // Interleaving 1: trava obtida após o claim do vencedor e antes do
        // settlement → item ENFILEIRADO → rejeição com bloqueio específico.
        expect(perdedor.claim.bloqueios).toContain("ITEM_NAO_PREPARADO");
        expect(rejeitados).toBe(1);
      } else {
        // Interleaving 2: trava obtida somente após o settlement → item
        // ENVIADO → idempotente com a MESMA chave persistida do vencedor.
        expect(perdedor.claim.estado).toBe("ENVIADO");
        const receipt = await pool!.query(
          "SELECT metadados FROM evento_auditoria WHERE agregado_id = $1 AND tipo = 'EXEC_RECEIPT'",
          [itemCorridaId],
        );
        const chaveVencedor = String(
          (receipt.rows[0] as { metadados: { chave_idempotencia: string } }).metadados
            .chave_idempotencia,
        );
        expect(perdedor.claim.chaveIdempotencia).toBe(chaveVencedor);
        expect(rejeitados).toBe(0);
      }
    } finally {
      await poolB.close();
    }
  });

  it("corrida do cancelamento: commit concorrente do lote vence o claim (CAS duplo)", async () => {
    const itemAlvo = (await pool!.query(
      "SELECT id FROM outbox_campanha WHERE lote_campanha_id = $1 AND estado = 'PREPARADO' LIMIT 1",
      [cenaCancelamento.loteCampanhaId],
    )).rows[0] as { id: string };
    // 1) Transação aberta que CANCELA o lote e segura a trava da linha do lote.
    const cliente = await pool!.connect();
    try {
      await cliente.query("BEGIN");
      const update = await cliente.query(
        "UPDATE lote_campanha SET estado = 'CANCELADO' WHERE id = $1 AND estado = 'ATIVO'",
        [cenaCancelamento.loteCampanhaId],
      );
      expect(update.rowCount).toBe(1);
      // 2) O claim tenta travar o MESMO lote e só segue DEPOIS do commit —
      //    ordem de travas consistente: lote primeiro, item depois.
      const provider = new ProvedorFakeCampanha();
      const promessaClaim = executar(pool!, provider, {
        operatorId: operadorId,
        campanhaId: cenaCancelamento.campanhaId,
        loteCampanhaId: cenaCancelamento.loteCampanhaId,
        itemId: itemAlvo.id,
      });
      await cliente.query("COMMIT");
      const resultado = await promessaClaim;
      expect(resultado.resultado).toBe("NAO_CLAIMADO");
      if (resultado.resultado !== "NAO_CLAIMADO") return;
      expect(resultado.claim.resultado).toBe("BLOQUEADO");
      if (resultado.claim.resultado !== "BLOQUEADO") return;
      expect(resultado.claim.bloqueios).toContain("LOTE_NAO_ATIVO");
      expect(provider.chamadas).toBe(0);
      expect(await estadoDoItem(pool!, itemAlvo.id)).toBe("PREPARADO");
      expect(await contarEventos(pool!, itemAlvo.id, "EXEC_CLAIM")).toBe(0);
    } finally {
      cliente.release();
    }
  });

  it("RECONSTRUCTION_AFTER_RESTART: decisão reconstruída de evento_auditoria por instância nova", async () => {
    const itemCrashId = randomUUID();
    const cenaCrash = await criarCenaLote(pool!, {
      operatorId: operadorId,
      estadoLote: "ATIVO",
      itens: [{ id: itemCrashId, estado: "PREPARADO" }],
    });
    const provider = new ProvedorFakeCampanha();
    const primeira = await executar(pool!, provider, {
      operatorId: operadorId,
      campanhaId: cenaCrash.campanhaId,
      loteCampanhaId: cenaCrash.loteCampanhaId,
      itemId: itemCrashId,
    });
    expect(primeira.resultado).toBe("ENVIADO");
    // "Instância nova" = segunda pool: NADA em memória, apenas estado persistido.
    const { NodePostgresPool } = await import("@integra-correios/persistence");
    const poolNovaInstancia = new NodePostgresPool({
      connectionString: DB_URL_AMBIENTE!,
      max: 1,
    });
    try {
      const eventos = await poolNovaInstancia.query(
        "SELECT tipo, metadados FROM evento_auditoria WHERE agregado_id = $1 AND agregado_tipo = 'CAMPANHA_EXECUCAO' ORDER BY sequencia",
        [itemCrashId],
      );
      const lista = eventos.rows as { tipo: string; metadados: Record<string, unknown> }[];
      const receipt = lista.find((e) => e.tipo === "EXEC_RECEIPT");
      expect(receipt).toBeDefined();
      const chave = String(receipt!.metadados.chave_idempotencia);
      // A chave idempotente canônica fluiu até o provider (message_id deriva dela).
      const messageId = String(receipt!.metadados.message_id);
      expect(messageId).toBe("campfake-" + chave.slice(0, 24));
      // A mesma tentativa repetida resolve idêntico SÓ com estado do banco.
      const repeticao = await executar(poolNovaInstancia, provider, {
        operatorId: operadorId,
        campanhaId: cenaCrash.campanhaId,
        loteCampanhaId: cenaCrash.loteCampanhaId,
        itemId: itemCrashId,
      });
      expect(repeticao.resultado).toBe("NAO_CLAIMADO");
      if (repeticao.resultado !== "NAO_CLAIMADO") return;
      expect(repeticao.claim.resultado).toBe("JA_CONCLUIDO");
      if (repeticao.claim.resultado !== "JA_CONCLUIDO") return;
      expect(repeticao.claim.estado).toBe("ENVIADO");
      expect(repeticao.claim.chaveIdempotencia).toBe(chave);
      expect(provider.chamadas).toBe(1);
    } finally {
      await poolNovaInstancia.close();
    }
  });
});
