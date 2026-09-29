import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * SLICE-03B — Contrato de apresentação da Macroetapa 4 (painel de controle
 * operacional). Provas por leitura de fonte (mesmo padrão de
 * campaign-resume-state.test.ts): a tela é server-driven, mostra
 * readiness/HOLD/bloqueios, mantém TODAS as ações desabilitadas com as
 * políticas fechadas e não usa Session Storage como autoridade.
 */
const FONTE_WORKSPACE = readFileSync(
  new URL("../src/pages/CampaignWorkspace.tsx", import.meta.url),
  "utf-8",
);

describe("SLICE_03B — Macroetapa 4: plano de controle operacional (frontend)", () => {
  it("readiness é buscado da rota read-only do servidor (server-driven, sem hash local)", () => {
    expect(FONTE_WORKSPACE).toContain("/api/campaigns/operational-readiness");
    expect(FONTE_WORKSPACE).toContain("obterReadinessOperacional");
  });

  it("readiness é estado derivado do servidor, limpo quando não há campanha aplicada", () => {
    expect(FONTE_WORKSPACE).toContain("setReadiness(null)");
    expect(FONTE_WORKSPACE).toMatch(/useEffect\(\(\) => \{[\s\S]{0,400}obterReadinessOperacional/);
  });

  it("painel de controle mostra campanha, lote, contagens, políticas e bloqueios", () => {
    expect(FONTE_WORKSPACE).toContain("Controle operacional (readiness)");
    expect(FONTE_WORKSPACE).toContain("contagemPorEstado");
    expect(FONTE_WORKSPACE).toContain("canPrepareBatch");
    expect(FONTE_WORKSPACE).toContain("canExecute");
    expect(FONTE_WORKSPACE).toContain("realSendEnabled");
    expect(FONTE_WORKSPACE).toContain("Autorização humana");
    expect(FONTE_WORKSPACE).toContain("Próxima ação necessária");
  });

  it("LOTE_CRIADO / HOLD permanece visível com motivo objetivo do bloqueio", () => {
    expect(FONTE_WORKSPACE).toContain("execução indisponível");
    expect(FONTE_WORKSPACE).toContain("LOTE_");
    expect(FONTE_WORKSPACE).toContain("EXECUTAR_ITEM.bloqueios");
  });

  it("confirmação de envio real desabilitado é exibida", () => {
    expect(FONTE_WORKSPACE).toContain("envioRealDesabilitado");
  });

  it("TODAS as ações de execução permanecem desabilitadas com as políticas fechadas", () => {
    const indice = FONTE_WORKSPACE.indexOf("Controle operacional (readiness)");
    const trecho = FONTE_WORKSPACE.slice(indice, indice + 7800);
    expect(trecho).toMatch(/type="button"\s+disabled=\{\s*!/);
    expect(trecho).toMatch(/type="button"\s+disabled>/);
    expect(trecho).toContain("Executar (provider indisponível — envio não autorizado)");
  });

  it("SLICE_03C.2A — readiness exibe OAuth read-only, canarySendEnabled e gate operacional pendente (P)", () => {
    const indice = FONTE_WORKSPACE.indexOf("Controle operacional (readiness)");
    const trecho = FONTE_WORKSPACE.slice(indice, indice + 7800);
    expect(trecho).toContain("canarySendEnabled=");
    expect(trecho).toContain("OAuth: configuração=");
    expect(trecho).toContain("sem\n                    teste ao vivo de token");
    expect(trecho).toContain('envioCanario.gateOperacional');
    expect(trecho).toContain("gateOperacional");
  });

  it("SLICE_03C.2A — Executar canário SEMPRE disabled, sem onClick e sem handler de envio (Q)", () => {
    const indice = FONTE_WORKSPACE.indexOf('Executar canário (gate operacional pendente');
    expect(indice).toBeGreaterThan(-1);
    const abertura = FONTE_WORKSPACE.lastIndexOf("<button", indice);
    const botao = FONTE_WORKSPACE.slice(abertura, indice + 200);
    expect(botao).toContain('<button type="button" disabled>');
    expect(botao.slice(0, botao.indexOf("Executar canário (gate"))).not.toContain("onClick");
    // Nenhum handler de envio do canário existe no cliente.
    const codigo = FONTE_WORKSPACE
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(codigo).not.toContain("canary-send");
    expect(codigo).not.toContain("executarCanario");
  });

  it("nenhuma autorização é derivada no cliente; ações refletem a capacidade do servidor", () => {
    const indice = FONTE_WORKSPACE.indexOf("Controle operacional (readiness)");
    const trecho = FONTE_WORKSPACE.slice(indice, indice + 5600);
    expect(trecho).toContain("readiness.acoes.PREPARAR_LOTE.permitida");
    expect(trecho).toContain("readiness.acoes.AUTORIZAR_EXECUCAO.permitida");
    expect(trecho).not.toMatch(/canExecute\s*=\s*true/);
    expect(trecho).not.toMatch(/localStorage|sessionStorage/i);
  });

  it("erros do servidor são sanitizados (mensagem da API, nunca stack/detalhe interno)", () => {
    expect(FONTE_WORKSPACE).toMatch(
      /setReadinessErro\(\s*error\s+instanceof\s+ApiCampanhaError/,
    );
    expect(FONTE_WORKSPACE).toContain("Readiness operacional indisponível.");
  });

  it("reload continua server-driven: nenhuma autoridade local no fluxo de readiness", () => {
    // Proibição ESCOPADA ao fluxo de readiness: o único sessionStorage do
    // arquivo é a limpeza legada de logout (fora deste fluxo).
    const inicio = FONTE_WORKSPACE.indexOf("obterReadinessOperacional(campanha.campanhaId)");
    const fim = FONTE_WORKSPACE.indexOf("visaoMacro = useMemo(");
    const fluxo = FONTE_WORKSPACE.slice(inicio, fim);
    expect(fluxo).not.toMatch(/sessionStorage|localStorage/i);
    expect(fluxo).toContain("setReadiness(null)");
  });

  it("zero Gmail/zero mutação: a tela não invoca rota produtiva de envio", () => {
    expect(FONTE_WORKSPACE).not.toContain("/api/execute");
    expect(FONTE_WORKSPACE).not.toContain("gmail");
  });
});
