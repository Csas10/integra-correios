import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  disposicaoRetomada,
  LIMPEZA_RETOMADA,
  type CampanhaRetomavelResumo,
} from "../src/pages/campaign-resume-state.js";
import { macroEtapaAtual } from "../src/pages/campaign-macro-stage.js";

// Resumo de descoberta SEM hash (corretivo): o hash de aprovação não faz
// parte do contrato de listagem — sai somente do detail autenticado.
const base: CampanhaRetomavelResumo = {
  campanhaId: "d3111f40-6b9b-498d-9a75-4385bea04e52",
  estado: "APROVADA",
  totalAprovados: 3,
  loteId: null,
  loteCodigo: null,
  loteEstado: null,
  outboxTotal: 0,
  outboxNaoExecutavel: 0,
  criadaEm: "2026-09-25T10:00:00.000Z",
};

// ---------------------------------------------------------------------------
// UX-FLOW-01B SERVER-DRIVEN RECOVERY AUTHORITY — corretivo
// LEGACY_HASH_RECOVERY_OVERWRITES_SERVER_DRIVEN_STATE.
// UX-FLOW-01B.1 DEAD HASH LIFECYCLE CLEANUP: o ciclo de hash (estado React,
// leitura e gravação de ic_campanha_hash) foi EXTINTO — sem leitor não há
// conveniência operacional; resta apenas a remoção histórica no logout.
// Ambiente de testes: `environment: "node"` (sem jsdom/testing-library), então
// a invariância arquitetural é provada por (a) módulos puros e (b) ANÁLISE
// DO CÓDIGO-FONTE REAL do componente — o mesmo mecanismo que gate anterior
// usou para provar a ausência de Gmail/worker nos fluxos operacionais.
// ---------------------------------------------------------------------------

const diretorioAtual = dirname(fileURLToPath(import.meta.url));
const caminhoComponente = resolve(diretorioAtual, "../src/pages/CampaignWorkspace.tsx");
const fonteComponente = existsSync(caminhoComponente) ? readFileSync(caminhoComponente, "utf-8") : "";

const efeitoLegadoRemovido = fonteComponente.length > 0;
const mid = (sub: string): string => {
  const i = fonteComponente.indexOf(sub);
  if (i < 0) throw new Error(`Trecho não encontrado no CampaignWorkspace.tsx: ${sub}`);
  return fonteComponente.slice(i);
};

describe("disposicaoRetomada — retomada server-driven (UX-FLOW-01B)", () => {
  it("lista vazia (EMPTY) → SEM_RETOMADA (ausência e alheio indistinguíveis)", () => {
    const disposicao = disposicaoRetomada([]);
    expect(disposicao.tipo).toBe("SEM_RETOMADA");
    expect(disposicao).not.toHaveProperty("campanha");
  });

  it("SINGLE APROVADA sem lote → PREPARAR_LOTE ('Campanha pronta para preparar lote')", () => {
    const disposicao = disposicaoRetomada([base]);
    expect(disposicao.tipo).toBe("PREPARAR_LOTE");
    if (disposicao.tipo !== "PREPARAR_LOTE") return;
    expect(disposicao.campanha.campanhaId).toBe(base.campanhaId);
    expect(disposicao.campanha.loteId).toBeNull();
    expect(disposicao.campanha.outboxTotal).toBe(0);
    expect(disposicao.totalRetomaveis).toBe(1);
  });

  it("SINGLE LOTE_CRIADO com lote HOLD → ACOMPANHAMENTO", () => {
    const disposicao = disposicaoRetomada([
      { ...base, estado: "LOTE_CRIADO", loteId: "lote-uuid-1", loteCodigo: "CAMPANHA_PF_4598820C09C7", loteEstado: "HOLD", outboxTotal: 3, outboxNaoExecutavel: 3 },
    ]);
    expect(disposicao.tipo).toBe("ACOMPANHAMENTO");
    if (disposicao.tipo !== "ACOMPANHAMENTO") return;
    expect(disposicao.campanha.loteEstado).toBe("HOLD");
    expect(disposicao.campanha.outboxTotal).toBe(3);
  });

  it("MULTIPLE (2+) → SELECAO_EXPLICITA_NECESSARIA, SEM campanha escolhida (nunca 'a mais recente')", () => {
    const antiga = { ...base, campanhaId: "campanha-antiga", criadaEm: "2026-09-20T10:00:00.000Z" };
    const recente = { ...base, campanhaId: "campanha-recente", criadaEm: "2026-09-25T12:00:00.000Z", estado: "LOTE_CRIADO", loteId: "lote-2", loteEstado: "HOLD" };
    const disposicao = disposicaoRetomada([recente, antiga]);
    expect(disposicao.tipo).toBe("SELECAO_EXPLICITA_NECESSARIA");
    if (disposicao.tipo !== "SELECAO_EXPLICITA_NECESSARIA") return;
    expect(disposicao.totalRetomaveis).toBe(2);
    expect(disposicao).not.toHaveProperty("campanha");
  });

  it("estado não retomável (cancelada) → SEM_RETOMADA com total ignorado", () => {
    const disposicao = disposicaoRetomada([{ ...base, estado: "CAMPAIGN_CANCELADA" }]);
    expect(disposicao.tipo).toBe("SEM_RETOMADA");
    if (disposicao.tipo !== "SEM_RETOMADA") return;
    expect(disposicao.ignoradas).toBe(1);
  });
});

describe("retomada cross-browser — destinos derivados (UX-FLOW-01B)", () => {
  it("Session Storage vazio: a decisão depende SOMENTE da lista server-driven", () => {
    const lista = [base];
    const semHash = disposicaoRetomada(lista);
    const comHash = disposicaoRetomada(lista);
    expect(semHash).toEqual(comHash);
    expect(semHash.tipo).toBe("PREPARAR_LOTE");
  });

  it("SINGLE APROVADA sem lote → abre Operação / preparar lote (macroetapa 4)", () => {
    const disposicao = disposicaoRetomada([base]);
    expect(disposicao.tipo).toBe("PREPARAR_LOTE");
    if (disposicao.tipo !== "PREPARAR_LOTE") return;
    const visao = macroEtapaAtual({
      sessaoAtiva: true,
      baseAvaliada: false,
      decisoesPendentes: false,
      aprovacaoPresente: false,
      campanha: {
        estado: disposicao.campanha.estado,
        loteId: disposicao.campanha.loteId,
        loteEstado: disposicao.campanha.loteEstado,
      },
    });
    expect(visao.macro).toBe(4);
    expect(visao.foco).toContain("preparar lote");
  });

  it("SINGLE LOTE_CRIADO/HOLD → abre Operação / acompanhamento (macroetapa 4)", () => {
    const disposicao = disposicaoRetomada([
      { ...base, estado: "LOTE_CRIADO", loteId: "lote-1", loteCodigo: "CAMPANHA_PF_TESTE", loteEstado: "HOLD" },
    ]);
    expect(disposicao.tipo).toBe("ACOMPANHAMENTO");
    if (disposicao.tipo !== "ACOMPANHAMENTO") return;
    const visao = macroEtapaAtual({
      sessaoAtiva: true,
      baseAvaliada: false,
      decisoesPendentes: false,
      aprovacaoPresente: false,
      campanha: {
        estado: disposicao.campanha.estado,
        loteId: disposicao.campanha.loteId,
        loteEstado: disposicao.campanha.loteEstado,
      },
    });
    expect(visao.macro).toBe(4);
    expect(visao.foco).toContain("Acompanhamento");
  });

  it("EMPTY → Preparação (nada selecionado pelo cliente)", () => {
    const disposicao = disposicaoRetomada([]);
    expect(disposicao.tipo).toBe("SEM_RETOMADA");
    const visao = macroEtapaAtual({
      sessaoAtiva: true,
      baseAvaliada: false,
      decisoesPendentes: false,
      aprovacaoPresente: false,
      campanha: null,
    });
    expect(visao.macro).toBe(2);
  });

  it("MULTIPLE: nenhuma retomada automática — nenhum foco ativo até seleção humana", () => {
    const outra = { ...base, campanhaId: "outra-campanha", criadaEm: "2026-09-24T00:00:00.000Z" };
    const disposicao = disposicaoRetomada([base, outra]);
    expect(disposicao.tipo).toBe("SELECAO_EXPLICITA_NECESSARIA");
    expect(disposicao).not.toHaveProperty("campanha");
    const visao = macroEtapaAtual({
      sessaoAtiva: true,
      baseAvaliada: false,
      decisoesPendentes: false,
      aprovacaoPresente: false,
      campanha: null,
    });
    expect(visao.macro).toBe(2);
  });
});

describe("GATE: SERVER-DRIVEN RECOVERY AUTHORITY — efeito legado removido (fonte real)", () => {
  it("pré-condição: fonte do componente legível (análise estrutural disponível)", () => {
    expect(fonteComponente.length).toBeGreaterThan(10000);
    expect(efeitoLegadoRemovido).toBe(true);
  });

  it("A·C·F: nenhum caminho de recuperação por hash no fluxo de retomada", () => {
    expect(fonteComponente).not.toContain("recuperacaoPorHashPermitida");
    expect(fonteComponente).not.toContain("persisted?hash=${encodeURIComponent(hashSessao)}");
    const janela = fonteComponente.indexOf("Retomada SERVER-DRIVEN");
    const fimJanela = fonteComponente.indexOf("async function retomarCampanhaSelecionada");
    const recorte = fonteComponente.slice(janela, fimJanela);
    expect(recorte).not.toContain("/api/campaigns/persisted");
  });

  it("B·D: efeitos de retomada são EXATAMENTE 4 — sem efeito de hash (request por hash não pode iniciar nem concorrer)", () => {
    // UX-FLOW-01B.1: loadMe, workspace/status, descoberta + readiness 03B
    // (slice-03B: efeito read-only de /api/campaigns/operational-readiness).
    const usos = fonteComponente.split("useEffect(").length - 1;
    expect(usos).toBe(4);
  });

  it("C·F: ciclo de hash EXTINTO — zero leitura e zero gravação de ic_campanha_hash (UX-FLOW-01B.1)", () => {
    expect(fonteComponente).not.toContain("sessionStorage.getItem(CHAVE_HASH_SESSAO)");
    expect(fonteComponente).not.toContain("sessionStorage.setItem(CHAVE_HASH_SESSAO");
    expect(fonteComponente).not.toContain("hashSessao");
    expect(fonteComponente).not.toContain("setHashSessao");
  });

  it("D: MULTIPLE pré-seleção — única limpeza é a sincronizada da própria descoberta", () => {
    const bloco = mid('if (resposta.mode === "MULTIPLE"');
    expect(bloco).toContain("setCampanha(null)");
    expect(bloco).toContain("Só o clique humano");
  });

  it("A·E: SINGLE e seleção explícita aplicam campanha EXCLUSIVAMENTE por /detail (sem ciclo de hash)", () => {
    const blocoSINGLE = mid('if (resposta.mode === "SINGLE"');
    expect(blocoSINGLE).toContain("obterCampanhaDetalhe");
    expect(blocoSINGLE).toContain("setCampanha(detalhe)");
    expect(blocoSINGLE).not.toContain("CHAVE_HASH_SESSAO");
    const blocoSelecao = mid("async function retomarCampanhaSelecionada");
    expect(blocoSelecao).toContain("obterCampanhaDetalhe");
    expect(blocoSelecao).toContain("setCampanha(detalhe)");
  });

  it("G: nenhum catch no fluxo de retomada executa setCampanha(null) — 403 legado não limpa estado", () => {
    const janela = fonteComponente.indexOf("Retomada SERVER-DRIVEN");
    const fimJanela = fonteComponente.indexOf("async function retomarCampanhaSelecionada");
    expect(janela).toBeGreaterThan(0);
    expect(fimJanela).toBeGreaterThan(janela);
    const recorte = fonteComponente.slice(janela, fimJanela);
    const matches = recorte.match(/catch[\s\S]{0,140}?setCampanha\(null\)/g) ?? [];
    expect(matches).toEqual([]);
    expect(recorte).toContain("setCampanha(detalhe)");
  });

  it("H: cleanup anti-stale (`ativo`) permanece nos 2 efeitos async (logout/desmontagem não aplicam resposta antiga)", () => {
    const janela = fonteComponente.indexOf("Retomada SERVER-DRIVEN");
    const fimJanela = fonteComponente.indexOf("Seleção EXPLÍCITA do operador");
    const recorte = fonteComponente.slice(janela, fimJanela);
    expect(recorte.split("let ativo = true;").length - 1).toBe(1);
    expect(recorte.split("ativo = false;").length - 1).toBe(1);
    expect(recorte).toContain("if (!ativo) return;");
    // File-wide: cleanup `ativo` nos 3 efeitos async restantes (status +
    // descoberta + readiness 03B).
    expect(fonteComponente.split("let ativo = true;").length - 1).toBe(3);
  });

  it("J: retomada é ZERO-MUTAÇÃO — nenhum POST na janela server-driven", () => {
    const janela = fonteComponente.indexOf("Retomada SERVER-DRIVEN");
    const fimJanela = fonteComponente.indexOf("Seleção EXPLÍCITA do operador");
    const recorte = fonteComponente.slice(janela, fimJanela);
    expect(recorte).not.toContain("method: \"POST\"");
  });

  it("política fail-closed intacta no cliente (nenhum flag habilitado para contornar o defeito)", () => {
    const recorte = mid("type CampaignPolicy");
    expect(recorte).toContain("canExecute: false");
    expect(mid("function persistirCampanha")).toContain("if (!base || !aprovacao) return;");
    expect(mid("function criarLoteCampanha")).toContain("if (!campanha) return;");
  });

  it("2º consumidor de /persisted permanece nos fluxos de CRIAÇÃO (escopo separado, não retomada)", () => {
    expect(fonteComponente.split("/api/campaigns/persisted?hash=").length - 1).toBe(2);
    expect(mid("SLICE-02 — persistir a campanha aprovada")).toContain("/api/campaigns/persisted?hash=");
    expect(mid("SLICE-02 — lote controlado")).toContain("/api/campaigns/persisted?hash=");
  });
});

describe("GATE: ciclo de hash extinto — Session Storage não é autoridade", () => {
  it("I: LIMPEZA_RETOMADA preserva o reset completo no logout (isolamento por operador)", () => {
    expect(LIMPEZA_RETOMADA.chaveHashSessao).toBe("ic_campanha_hash");
    expect(LIMPEZA_RETOMADA.campanha).toBeNull();
    expect(LIMPEZA_RETOMADA.modo).toBe("INDEFINIDO");
    expect(LIMPEZA_RETOMADA.retomada.status).toBe("indefinida");
    expect(fonteComponente).toContain("sessionStorage.removeItem(LIMPEZA_RETOMADA.chaveHashSessao)");
  });

  it("logout/removeItem preservado como limpeza HISTÓRICA; hash nunca é lido nem gravado", () => {
    // Justificativa do removeItem (gate 01B.1 item 6): remove resíduos de
    // ic_campanha_hash gravados por versões anteriores; não alimenta
    // nenhuma recuperação — não existe leitor da chave.
    expect(fonteComponente.split("sessionStorage.removeItem(LIMPEZA_RETOMADA.chaveHashSessao)").length - 1).toBe(1);
    expect(fonteComponente).not.toContain("sessionStorage.getItem(CHAVE_HASH_SESSAO)");
    expect(fonteComponente).not.toContain("sessionStorage.setItem(CHAVE_HASH_SESSAO");
    // A janela server-driven de retomada não contém NENHUMA referência a
    // /persisted (os 2 consumidores restantes estão nos fluxos de criação).
    const janela = fonteComponente.indexOf("Retomada SERVER-DRIVEN");
    const fimJanela = fonteComponente.indexOf("async function retomarCampanhaSelecionada");
    const recorte = fonteComponente.slice(janela, fimJanela);
    expect(recorte).not.toContain("/api/campaigns/persisted");
    expect(recorte).not.toContain("fetch(");
  });
});
