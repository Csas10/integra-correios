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
    const recargas = (
      codigo.match(
        /Promise\.all\(\[\s*obterCampanhaDetalhe\(campanha\.campanhaId\),\s*obterReadinessOperacional\(campanha\.campanhaId\),\s*\]\)/g,
      ) ?? []
    ).length;
    // PREPARAR/AUTORIZAR/ATIVAR (1) + pós-canário (1) + pós-lote GF5.3 (1)
    // = 3 pontos de sincronia (mesmo padrão server-driven).
    expect(recargas).toBe(3);
    expect(codigo).toContain("setCampanha(detalhe)");
    expect(codigo).toContain("setReadiness(corpoReadiness)");
    // Nenhuma transição/estado local é inferido do POST.
    expect(codigo).not.toMatch(/loteEstado\s*[:=]\s*"ATIVO"/);
    expect(codigo).not.toMatch(/loteEstado\s*[:=]\s*"PREPARADO"/);
  });

  // ---------------------------------------------------------------------
  // GF4.5C.1 (FINDING 2) — adjudicação independente do resultado do POST
  // vs. sincronização read-only, provada ESTRUTURALMENTE sobre o handler.
  // ---------------------------------------------------------------------
  it("GF4.5C.1 — fail-closed: readiness antigo é invalidado (setReadiness(null)) ANTES do despacho do canário", () => {
    const codigo = FONTE_WORKSPACE
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const indice = codigo.indexOf("async function executarCanarioOperacionalUI");
    const fim = codigo.indexOf("  // UX-FLOW-01A", indice);
    const handler = codigo.slice(indice, fim);
    const indiceSet = handler.indexOf("setReadiness(null)");
    const indicePost = handler.indexOf("executarCanarioOperacional(campanha.campanhaId)");
    // A invalidação ocorre ANTES do POST (stale permitida=true não rearma).
    expect(indiceSet).toBeGreaterThan(-1);
    expect(indicePost).toBeGreaterThan(indiceSet);
    // Nenhuma permissão substituta é derivada localmente.
    expect(handler).not.toMatch(/permitida\s*[:=]\s*true/);
  });

  it("GF4.5C.1 — domínios de erro distintos: sincronização read-only tem catch PRÓPRIO e não reescreve o resultado", () => {
    const indice = FONTE_WORKSPACE.indexOf("async function executarCanarioOperacionalUI");
    const fim = FONTE_WORKSPACE.indexOf("  // UX-FLOW-01A", indice);
    const handler = FONTE_WORKSPACE.slice(indice, fim);
    // O POST é adjudicado PRIMEIRO (await executarCanarioOperacional) e a
    // mensagem do resultado é definida ANTES do bloco de sincronização.
    const indicePost = handler.indexOf("await executarCanarioOperacional(campanha.campanhaId)");
    const indiceMsg = handler.indexOf("Canário: " + "");
    expect(indicePost).toBeGreaterThan(-1);
    // try/catch PRÓPRIO da sincronização (domínio separado da mutação):
    const indiceSync = handler.indexOf("try {", indiceMsg > 0 ? indiceMsg : indicePost);
    expect(indiceSync).toBeGreaterThan(-1);
    const catchSync = handler.slice(indiceSync, handler.indexOf("} catch (error: unknown) {", indiceSync));
    expect(catchSync).toContain("Falha na sincronização do estado pós-envio");
    // A falha de refresh mantém o resultado: setReadiness(null) + erro de
    // sincronização; NUNCA "não conclusivo" no catch da sincronização.
    expect(catchSync).not.toContain("não conclusivo");
    expect(catchSync).toContain("setReadiness(null)");
  });

  it("GF4.5C.1 — 4xx é rejeição DEFINITIVA (sem 'não conclusivo'); rede/5xx é conservador", () => {
    const codigo = FONTE_WORKSPACE
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const indice = codigo.indexOf("async function executarCanarioOperacionalUI");
    const fim = codigo.indexOf("  // UX-FLOW-01A", indice);
    const handler = codigo.slice(indice, fim);
    expect(handler).toContain("error instanceof ApiCampanhaError && error.status >= 400 && error.status < 500");
    expect(handler).toContain("Rejeição definitiva do servidor");
    // O ramo 4xx NÃO apenda a frase de ambiguidade; o ramo conservador apenda
    // "potencialmente não conclusivo".
    const indice4xx = handler.indexOf("Rejeição definitiva do servidor");
    const trecho4xx = handler.slice(handler.lastIndexOf("if (", indice4xx), indice4xx + 120);
    expect(trecho4xx).not.toContain("não conclusivo");
    expect(handler).toContain("potencialmente não conclusivo (falha de rede/servidor)");
  });

  it("GF4.5C.1 — AMBIGUO permanece não conclusivo; exatamente UM POST por confirmação; ZERO retry/timer", () => {
    const codigo = FONTE_WORKSPACE
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(codigo).toContain('corpo.resultado === "AMBIGUO"');
    expect(codigo).toContain("Resultado do canário não conclusivo. Não repetir automaticamente.");
    const indice = codigo.indexOf("async function executarCanarioOperacionalUI");
    const fim = codigo.indexOf("  // UX-FLOW-01A", indice);
    const handler = codigo.slice(indice, fim);
    // Exatamente UM POST do canário no handler.
    expect(handler.split("executarCanarioOperacional(campanha.campanhaId)").length - 1).toBe(1);
    // Nenhum retry automático/timer/loop.
    expect(codigo).not.toMatch(/setInterval|setTimeout\(\s*[a-zA-Z]*retry/i);
    expect(handler).not.toContain("while (");
  });

  it("GF4.5C.1 — resultado/erro do canário exibidos INDEPENDENTES do readiness (mensagens fora do painel condicional)", () => {
    const codigo = FONTE_WORKSPACE;
    // Os parágrafos de mensagem existem FORA do bloco condicional {readiness ? …},
    // imediatamente após o carregamento do readiness.
    const indiceMensagem = codigo.indexOf('{/* GF4.5C.1 — resultado/erro do canário visíveis INDEPENDENTES do');
    expect(indiceMensagem).toBeGreaterThan(-1);
    const entre = codigo.slice(
      codigo.indexOf("Carregando readiness operacional…"),
      indiceMensagem,
    );
    expect(entre.length).toBeLessThan(400);
    // E o painel {readiness ? …} não contém mais acaoMensagem/acaoErro:
    const indicePainel = codigo.indexOf("{readiness ? (");
    const fimPainel = codigo.indexOf("mostrarOperacao && (", indicePainel);
    const painel = codigo.slice(indicePainel, fimPainel);
    expect(painel).not.toContain("{acaoMensagem ?");
    expect(painel).not.toContain("{acaoErro ?");
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
// ---------------------------------------------------------------------------
// GF5.3 — Executar lote: matriz obrigatória da UI (17–31). Provas por leitura
// de fonte (mesmo padrão das suítes de controle): autoridade EXCLUSIVA do
// readiness server-driven, confirmação humana, guardas de duplo clique,
// fail-closed de readiness e domínios de erro separados.
// ---------------------------------------------------------------------------
describe("GF5.3 — Executar lote (UI): autoridade server-driven e guardas", () => {
  const codigo = FONTE_WORKSPACE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  function trechoEntre(inicio: string, fim: string): string {
    const i = codigo.indexOf(inicio);
    expect(i, "âncora inicial: " + inicio).toBeGreaterThan(-1);
    const j = codigo.indexOf(fim, i);
    expect(j, "âncora final: " + fim).toBeGreaterThan(-1);
    return codigo.slice(i, j);
  }

  // (17) botão existe + (18) governado EXCLUSIVAMENTE por
  // readiness.acoes.EXECUTAR_LOTE.permitida (+ guardas locais de pendência).
  it("17+18. botão do lote existe e é governado EXCLUSIVAMENTE por EXECUTAR_LOTE.permitida", () => {
    const indice = codigo.indexOf('!readiness.acoes.EXECUTAR_LOTE.permitida');
    expect(indice).toBeGreaterThan(-1);
    const abertura = codigo.lastIndexOf("<button", indice);
    const botao = codigo.slice(abertura, codigo.indexOf("</button>", indice));
    expect(botao).toContain("type=\"button\"");
    // Nenhuma derivação local de elegibilidade (flags/contagens/estado):
    expect(botao).not.toContain("batchSendEnabled");
    expect(botao).not.toContain("canExecute");
    expect(botao).not.toContain("realSendEnabled");
    expect(botao).not.toContain("lote.estado");
    expect(botao).not.toContain("oauth");
  });

  // (19) nenhuma reconstrução local da elegibilidade do lote no arquivo.
  it("19. nenhuma reconstrução local de elegibilidade (rota única + permissão só do servidor)", () => {
    const api = trechoEntre(
      "async function executarLoteOperacional(",
      "class ApiCampanhaError",
    );
    expect(api).toContain('"/api/campaigns/batch-send"');
    expect(api).toContain("body: JSON.stringify({ campanhaId })");
    // Nenhuma segunda rota/loop/derivação de permissão no cliente.
    expect(api).not.toContain("permitida");
    expect(api).not.toContain("|| readiness.politicas");
  });

  // (20) confirmação humana explícita com conteúdo objetivo + (21) cancelar
  // ⇒ ZERO POST + (26) nenhuma repetição automática (timer/loop/fila).
  it("20+21+26. confirmação objetiva; cancelar ⇒ ZERO POST; nenhum retry/timer/loop", () => {
    const fn = trechoEntre(
      "async function executarLoteOperacionalUI(",
      "const visaoMacro = useMemo(",
    );
    expect(fn).toContain("window.confirm(");
    expect(fn).toContain("no máximo 10 itens");
    expect(fn).toContain("Não há retry automático");
    expect(fn).toContain("nova ação humana explícita");
    // Cancelar ⇒ ZERO POST: o fetch só ocorre DEPOIS do gate do confirm.
    const iConfirm = fn.indexOf("window.confirm(");
    const iFetch = fn.indexOf("await executarLoteOperacional(");
    expect(iFetch).toBeGreaterThan(iConfirm);
    // Cancelar ⇒ ZERO POST: o gate "if (!confirmado) … return;" fica entre o
    // confirm e o despacho (nunca depois do POST).
    const iGate = fn.indexOf("if (!confirmado)");
    expect(iGate).toBeGreaterThan(iConfirm);
    expect(fn.slice(iGate, iFetch)).toContain("return;");
    // Nenhuma repetição automática em nenhum lugar do arquivo.
    expect(codigo).not.toMatch(/setInterval\(|setTimeout\([^,]*executarLote|autoContinue/i);
  });

  // (22) exatamente UM POST por confirmação + (24) guarda dedicada de duplo
  // clique/reação + (25) readiness invalidado antes do despacho.
  it("22+24+25. uma confirmação = um POST; lotePendente; setReadiness(null) antes do despacho", () => {
    const fn = trechoEntre(
      "async function executarLoteOperacionalUI(",
      "const visaoMacro = useMemo(",
    );
    expect(fn).toContain("if (!campanha?.campanhaId || acaoPendente !== null || lotePendente || canarioPendente) return;");
    expect(fn).toContain("setLotePendente(true)");
    expect(fn).toContain("setReadiness(null);");
    expect(fn).toContain("await executarLoteOperacional(campanha.campanhaId)");
    // Exatamente UMA chamada de POST dentro do handler.
    expect(fn.match(/await executarLoteOperacional\(/g) ?? []).toHaveLength(1);
    expect(fn).toContain('} finally {\n      setLotePendente(false);\n    }');
  });

  // (23) corpo EXATAMENTE { campanhaId } (nenhuma autoridade adicional).
  it("23. corpo do POST é exatamente { campanhaId }", () => {
    const api = trechoEntre(
      "async function executarLoteOperacional(",
      "class ApiCampanhaError",
    );
    expect(api).toContain('body: JSON.stringify({ campanhaId })');
    expect(api).not.toMatch(/JSON\.stringify\(\{[^}]*limit|batchSize|maxItems|offset|cursor|itemIds|operatorId/);
  });

  // (27) PARCIAL não auto-continua: mensagem exige nova ação humana; nenhuma
  // re-invocação do POST em nenhum ramo do handler.
  it("27. PARCIAL ⇒ mensagem explícita de continuação manual; ZERO auto-continue", () => {
    const fn = trechoEntre(
      "async function executarLoteOperacionalUI(",
      "const visaoMacro = useMemo(",
    );
    expect(fn).toContain('"PARCIAL"');
    expect(fn).toContain("Continuação somente com nova ação humana explícita");
    // Nenhum ramo chama o POST novamente (nem condicionalmente).
    expect(fn.match(/await executarLoteOperacional\(/g) ?? []).toHaveLength(1);
  });

  // (28) resultado DEFINITIVO do POST sobrevive à falha de refresh (domínios
  // de erro separados; readiness nulo; nenhuma reescrita da mensagem).
  it("28. resultado do POST preservado se a sincronização pós-execução falhar", () => {
    const fn = trechoEntre(
      "async function executarLoteOperacionalUI(",
      "const visaoMacro = useMemo(",
    );
    const iMutacao = fn.indexOf("await executarLoteOperacional(campanha.campanhaId)");
    const iSync = fn.indexOf("try {\n        const [detalhe, corpoReadiness]");
    const iFalhaSync = fn.indexOf('"Falha na sincronização do estado pós-execução');
    expect(iSync).toBeGreaterThan(iMutacao);
    expect(iFalhaSync).toBeGreaterThan(iSync);
    // A sincronização é um try/catch PRÓPRIO dentro do try da mutação: falha
    // de refresh não apaga mensagem nem dispara novo POST.
    const blocoSync = fn.slice(iSync, iFalhaSync + 200);
    expect(blocoSync).toContain("catch");
    expect(blocoSync).toContain("setReadiness(null)");
  });

  // (29) 4xx ⇒ rejeição DEFINITIVA (sem "não conclusivo").
  it("29. 4xx é classificado como rejeição definitiva", () => {
    const fn = trechoEntre(
      "async function executarLoteOperacionalUI(",
      "const visaoMacro = useMemo(",
    );
    const i4xx = fn.indexOf("error.status >= 400 && error.status < 500");
    expect(i4xx).toBeGreaterThan(-1);
    const ramo4xx = fn.slice(i4xx, fn.indexOf("} else {", i4xx));
    expect(ramo4xx).toContain("Rejeição definitiva do servidor");
    expect(ramo4xx).not.toContain("NÃO CONCLUSIVO");
  });

  // (30) rede/5xx ⇒ POTENCIALMENTE NÃO CONCLUSIVO (itens podem ter sido
  // settlementados; sem retry; somente readiness novo autoriza continuação).
  it("30. rede/5xx é conservador: potencialmente não conclusivo, sem retry", () => {
    const fn = trechoEntre(
      "async function executarLoteOperacionalUI(",
      "const visaoMacro = useMemo(",
    );
    expect(fn).toContain("NÃO CONCLUSIVO");
    expect(fn).toContain("podem já ter sido processados");
    expect(fn).toContain("somente um readiness novo do servidor autoriza continuação");
  });

  // (31) aggregate exibido sem PII: somente contagens + motivo sanitizado.
  it("31. contagens agregadas exibidas sem recipient PII", () => {
    const fn = trechoEntre(
      "async function executarLoteOperacionalUI(",
      "const visaoMacro = useMemo(",
    );
    expect(fn).toContain("processadosNestaExecucao");
    expect(fn).toContain("enviadosNestaExecucao");
    expect(fn).toContain("restantesPreparados");
    // Nenhum campo de PII/segredo é lido do resultado do POST.
    expect(fn).not.toMatch(/receipt|fingerprint|access_token|email|destinatario/);
  });

  // Complemento — rótulo Continuar lote derivado SOMENTE de estado sanitizado
  // do servidor (contagem PREPARADO do readiness), sem mudar a autoridade.
  it("complemento. rótulo Continuar lote deriva apenas de contagem sanitizada do readiness", () => {
    const indice = codigo.indexOf('!readiness.acoes.EXECUTAR_LOTE.permitida');
    const abertura = codigo.lastIndexOf("<button", indice);
    const botao = codigo.slice(abertura, codigo.indexOf("</button>", indice));
    expect(botao).toContain('"Continuar lote"');
    expect(botao).toContain("contagemPorEstado.PREPARADO");
  });
});
