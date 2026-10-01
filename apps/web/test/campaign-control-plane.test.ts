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

  it("TODAS as ações permanecem desabilitadas com as políticas fechadas; execução genérica segue SEM handler", () => {
    const indice = FONTE_WORKSPACE.indexOf("Controle operacional (readiness)");
    const trecho = FONTE_WORKSPACE.slice(indice, indice + 9000);
    expect(trecho).toMatch(/type="button"\s+disabled=\{\s*!/);
    expect(trecho).toMatch(/type="button"\s+disabled>/);
    expect(trecho).toContain("Executar (provider indisponível — envio não autorizado)");
    const abertura = FONTE_WORKSPACE.lastIndexOf("<button", indice + trecho.indexOf("Executar (provider indisponível"));
    const botaoGenerico = FONTE_WORKSPACE.slice(abertura, indice + trecho.indexOf("Executar (provider indisponível"));
    expect(botaoGenerico).not.toContain("onClick");
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

  it("GF4.5 — canário: handler único na rota canônica com corpo restrito a campanhaId", () => {
    const codigo = FONTE_WORKSPACE
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(codigo).toContain('"/api/campaigns/canary-send"');
    expect(codigo).toContain("executarCanarioOperacional");
    const indiceFn = codigo.indexOf("async function executarCanarioOperacional");
    expect(indiceFn).toBeGreaterThan(-1);
    const fn = codigo.slice(indiceFn, indiceFn + 700);
    expect(fn).toContain("body: JSON.stringify({ campanhaId })");
    // Nenhum dado de autoridade é aceito/enviado pelo browser: somente o
    // campanhaId; o servidor reconstrói TODA a autoridade.
    expect(fn).not.toContain("operatorId");
    expect(fn).not.toContain("itemId");
    expect(fn).not.toContain("fingerprint");
    expect(fn).not.toContain("token");
    expect(fn).not.toContain("idempotencia");
  });

  it("GF4.5 — canário: botão governado EXCLUSIVAMENTE pelo readiness server-driven (sem derivação local)", () => {
    const indice = FONTE_WORKSPACE.indexOf("Executar canário controlado");
    expect(indice).toBeGreaterThan(-1);
    const abertura = FONTE_WORKSPACE.lastIndexOf("<button", indice);
    const botao = FONTE_WORKSPACE.slice(abertura, indice);
    expect(botao).toContain("!readiness.acoes.EXECUTAR_CANARIO.permitida");
    expect(botao).toContain("canarioPendente");
    expect(botao).toContain("executarCanarioOperacionalUI");
    // Elegibilidade NUNCA vem de combinação local de flags/estado/OAuth.
    expect(botao).not.toContain("politicas");
    expect(botao).not.toContain("canarySendEnabled");
    expect(botao).not.toContain("realSendEnabled");
    expect(botao).not.toContain("lote.estado");
    expect(botao).not.toContain("oauth");
  });

  it("GF4.5 — canário: confirmação humana obrigatória; cancelar ⇒ ZERO POST; exatamente UM POST por confirmação", () => {
    const codigo = FONTE_WORKSPACE
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(codigo).toContain("Executar o canário real controlado?");
    expect(codigo).toContain("exatamente um envio real pelo Gmail");
    expect(codigo).toContain("Não haverá lote completo nem retry automático");
    expect(codigo).toContain("Confirme somente se o gate de canário foi explicitamente autorizado");
    // Cancelamento ANTES do POST: retorno imediato sem fetchJson do canário.
    const indiceConfirm = codigo.indexOf("if (!confirmado) {");
    expect(indiceConfirm).toBeGreaterThan(-1);
    const guarda = codigo.slice(indiceConfirm, indiceConfirm + 220);
    expect(guarda).toContain("setAcaoErro(\"\")");
    // O POST do canário existe exatamente UMA vez no fluxo do handler.
    expect(codigo.split("executarCanarioOperacional(campanha.campanhaId)").length - 1).toBe(1);
  });

  it("GF4.5 — canário: ambiguidade/falha ⇒ ZERO repetição automática; aviso sanitizado", () => {
    const codigo = FONTE_WORKSPACE
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(codigo).toContain(
      "Resultado do canário não conclusivo. Não repetir automaticamente. Verifique o estado persistido antes de qualquer nova tentativa.",
    );
    expect(codigo).toContain('corpo.resultado === "AMBIGUO"');
    // Nenhum timer/loop/polling de envio no cliente.
    expect(codigo).not.toMatch(/setInterval/);
  });

  it("GF4.5 — pós-mutação e pós-canário: detail + readiness recarregados SERVER-DRIVEN via Promise.all", () => {
    const codigo = FONTE_WORKSPACE
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const recargas = codigo.split(
      "Promise.all([\n        obterCampanhaDetalhe(campanha.campanhaId),\n        obterReadinessOperacional(campanha.campanhaId),\n      ])",
    ).length - 1;
    // PREPARAR/AUTORIZAR/ATIVAR (1) + pós-canário (1) = 2 pontos de sincronia.
    expect(recargas).toBe(2);
    expect(codigo).toContain("setCampanha(detalhe)");
    expect(codigo).toContain("setReadiness(corpoReadiness)");
    // Nenhuma transição/estado local é inferido do POST.
    expect(codigo).not.toMatch(/loteEstado\s*[:=]\s*"ATIVO"/);
    expect(codigo).not.toMatch(/loteEstado\s*[:=]\s*"PREPARADO"/);
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
