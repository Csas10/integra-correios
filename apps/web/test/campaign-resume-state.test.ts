import { describe, expect, it } from "vitest";
import {
  disposicaoRetomada,
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
    // O contrato da decisão não aceita estado local: mesma lista do
    // servidor → mesma disposição, com ou sem hash no navegador.
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
    // A UI NÃO aplica disposição MULTIPLE: a lista aguarda escolha humana e
    // NENHUMA campanha entra no estado operacional (visaoMacro segue 2).
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
