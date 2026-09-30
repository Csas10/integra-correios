import { describe, expect, it } from "vitest";
import {
  macroEtapaAtual,
  mapeamentoDeterministico,
  pendenciasMapeamento,
  destinoAposEvento,
} from "../src/pages/campaign-macro-stage.js";

const semSessao = {
  sessaoAtiva: false,
  baseAvaliada: false,
  decisoesPendentes: false,
  aprovacaoPresente: false,
  campanha: null,
};
const campanhaAprovadaSemLote = { estado: "APROVADA", loteId: null, loteEstado: null };
const campanhaLoteCriado = { estado: "LOTE_CRIADO", loteId: "lote-uuid-1", loteEstado: "HOLD" };

describe("macroEtapaAtual — derivação do estado operacional (UX-FLOW-01A)", () => {
  it("sem sessão → macroetapa 1 Identificação", () => {
    const visao = macroEtapaAtual(semSessao);
    expect(visao.macro).toBe(1);
    expect(visao.macroId).toBe("IDENTIFICACAO");
    expect(visao.mostrarPainelAtividade).toBe(false);
    expect(visao.revisaoUnificada).toBe(false);
  });

  it("sessão sem base e sem campanha → macroetapa 2 Preparação", () => {
    const visao = macroEtapaAtual({ ...semSessao, sessaoAtiva: true });
    expect(visao.macro).toBe(2);
    expect(visao.macroId).toBe("PREPARACAO");
    expect(visao.foco).toContain("Importar");
  });

  it("mapeamento/decisões pendentes → permanece em Preparação (exceções)", () => {
    const visao = macroEtapaAtual({
      sessaoAtiva: true,
      baseAvaliada: true,
      decisoesPendentes: true,
      aprovacaoPresente: false,
      campanha: null,
    });
    expect(visao.macro).toBe(2);
    expect(visao.foco).toContain("Decisões humanas pendentes");
  });

  it("avaliação concluída sem pendências → macroetapa 3 Revisão e aprovação", () => {
    const visao = macroEtapaAtual({
      sessaoAtiva: true,
      baseAvaliada: true,
      decisoesPendentes: false,
      aprovacaoPresente: false,
      campanha: null,
    });
    expect(visao.macro).toBe(3);
    expect(visao.macroId).toBe("REVISAO");
    expect(visao.revisaoUnificada).toBe(true);
  });

  it("aprovação congelada sem persistência → permanece em Revisão (persistência é ação explícita)", () => {
    const visao = macroEtapaAtual({
      sessaoAtiva: true,
      baseAvaliada: true,
      decisoesPendentes: false,
      aprovacaoPresente: true,
      campanha: null,
    });
    expect(visao.macro).toBe(3);
    expect(visao.foco).toContain("persistir campanha");
  });

  it("campanha APROVADA sem lote → Operação (preparar lote)", () => {
    const visao = macroEtapaAtual({
      sessaoAtiva: true,
      baseAvaliada: false,
      decisoesPendentes: false,
      aprovacaoPresente: false,
      campanha: campanhaAprovadaSemLote,
    });
    expect(visao.macro).toBe(4);
    expect(visao.macroId).toBe("OPERACAO");
    expect(visao.foco).toContain("preparar lote");
    expect(visao.mostrarPainelAtividade).toBe(true);
  });

  it("campanha LOTE_CRIADO com lote HOLD → Operação (acompanhamento)", () => {
    const visao = macroEtapaAtual({
      sessaoAtiva: true,
      baseAvaliada: false,
      decisoesPendentes: false,
      aprovacaoPresente: false,
      campanha: campanhaLoteCriado,
    });
    expect(visao.macro).toBe(4);
    expect(visao.foco).toContain("Acompanhamento");
  });
});

describe("mapeamentoDeterministico — regras homologadas do importador", () => {
  const obrigatorios = ["profissional_id", "nome", "email_original"];

  it("sugestão cobre todos os obrigatórios com colunas distintas → determinístico", () => {
    expect(
      mapeamentoDeterministico({ profissional_id: 0, nome: 1, email_original: 2 }, obrigatorios),
    ).toBe(true);
  });

  it("obrigatório sem sugestão (-1) → NÃO determinístico (exige decisão humana)", () => {
    expect(
      mapeamentoDeterministico({ profissional_id: 0, nome: -1, email_original: 2 }, obrigatorios),
    ).toBe(false);
  });

  it("obrigatório ausente do mapa → NÃO determinístico", () => {
    expect(mapeamentoDeterministico({ profissional_id: 0, nome: 1 }, obrigatorios)).toBe(false);
  });

  it("duas colunas iguais para campos distintos → NÃO determinístico", () => {
    expect(
      mapeamentoDeterministico({ profissional_id: 0, nome: 0, email_original: 2 }, obrigatorios),
    ).toBe(false);
  });
});

describe("pendenciasMapeamento — só os campos que exigem decisão", () => {
  const obrigatorios = ["profissional_id", "nome", "email_original"];

  it("mapeamento determinístico → nenhuma pendência", () => {
    expect(
      pendenciasMapeamento({ profissional_id: 0, nome: 1, email_original: 2 }, obrigatorios),
    ).toEqual([]);
  });

  it("obrigatório sem coluna → listado como decisão pendente", () => {
    expect(
      pendenciasMapeamento({ profissional_id: 0, nome: -1, email_original: 2 }, obrigatorios),
    ).toEqual(["nome"]);
  });

  it("coluna duplicada entre obrigatórios → AMBOS voltam à decisão (ambiguidade)", () => {
    expect(
      pendenciasMapeamento({ profissional_id: 0, nome: 0, email_original: 2 }, obrigatorios),
    ).toEqual(["profissional_id", "nome"]);
  });

  it("arquivo ambíguo: última decisão resolve → pendências zeradas", () => {
    const antes = pendenciasMapeamento({ nome: 1 }, obrigatorios);
    expect(antes).toEqual(["profissional_id", "email_original"]);
    const depois = pendenciasMapeamento({ profissional_id: 0, nome: 1, email_original: 2 }, obrigatorios);
    expect(depois).toEqual([]);
  });
});

describe("destinoAposEvento — avanços automáticos sem encadear mutações", () => {
  it("SESSAO_INICIADA sem nada → Preparação (nunca salta para Operação)", () => {
    const destino = destinoAposEvento(
      { tipo: "SESSAO_INICIADA" },
      { sessaoAtiva: false, baseAvaliada: false, decisoesPendentes: false, aprovacaoPresente: false, campanha: null },
    );
    expect(destino.macro).toBe(2);
  });

  it("ARQUIVO_ANALISADO determinístico → segue direto para avaliação (destino derivado)", () => {
    const destino = destinoAposEvento(
      { tipo: "ARQUIVO_ANALISADO", mapeamentoDeterministico: true },
      { sessaoAtiva: true, baseAvaliada: false, decisoesPendentes: false, aprovacaoPresente: false, campanha: null },
    );
    expect(destino.macro).toBe(2); // base ainda não avaliada; mapeamento manual é pulado
  });

  it("BASE_AVALIADA com pendências → Preparação (exceções visíveis)", () => {
    const destino = destinoAposEvento(
      { tipo: "BASE_AVALIADA", decisoesPendentes: true },
      { sessaoAtiva: true, baseAvaliada: false, decisoesPendentes: false, aprovacaoPresente: false, campanha: null },
    );
    expect(destino.macro).toBe(2);
  });

  it("BASE_AVALIADA sem pendências → Revisão unificada", () => {
    const destino = destinoAposEvento(
      { tipo: "BASE_AVALIADA", decisoesPendentes: false },
      { sessaoAtiva: true, baseAvaliada: false, decisoesPendentes: false, aprovacaoPresente: false, campanha: null },
    );
    expect(destino.macro).toBe(3);
    expect(destino.revisaoUnificada).toBe(true);
  });

  it("ULTIMA_DECISAO_RESOLVIDA → abre revisão automaticamente", () => {
    const destino = destinoAposEvento(
      { tipo: "ULTIMA_DECISAO_RESOLVIDA", aptos: 3 },
      { sessaoAtiva: true, baseAvaliada: true, decisoesPendentes: true, aprovacaoPresente: false, campanha: null },
    );
    expect(destino.macro).toBe(3);
  });

  it("APROVACAO_CONGELADA NÃO encadeia persistência nem lote: fica em Revisão", () => {
    const destino = destinoAposEvento(
      { tipo: "APROVACAO_CONGELADA" },
      { sessaoAtiva: true, baseAvaliada: true, decisoesPendentes: false, aprovacaoPresente: false, campanha: null },
    );
    expect(destino.macro).toBe(3);
    expect(destino.foco).toContain("persistir campanha");
  });

  it("CAMPANHA_PERSISTIDA sem lote → Operação (preparar lote), sem criar lote automaticamente", () => {
    const destino = destinoAposEvento(
      { tipo: "CAMPANHA_PERSISTIDA", loteId: null },
      { sessaoAtiva: true, baseAvaliada: true, decisoesPendentes: false, aprovacaoPresente: true, campanha: null },
    );
    expect(destino.macro).toBe(4);
    expect(destino.foco).toContain("preparar lote");
  });

  it("LOTE_CRIADO com campanha previamente nula (retomada server-driven) → Acompanhamento", () => {
    const destino = destinoAposEvento(
      { tipo: "LOTE_CRIADO" },
      { sessaoAtiva: true, baseAvaliada: false, decisoesPendentes: false, aprovacaoPresente: false, campanha: campanhaLoteCriado },
    );
    expect(destino.macro).toBe(4);
    expect(destino.foco).toContain("Acompanhamento");
  });
});
