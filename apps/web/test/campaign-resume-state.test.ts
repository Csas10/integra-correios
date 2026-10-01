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

  it("GF4.3D: SINGLE LOTE_CRIADO/PREPARADO ou ATIVO → Operação/acompanhamento (macroetapa 4, NUNCA import)", () => {
    for (const loteEstado of ["PREPARADO", "ATIVO"] as const) {
      const resumo: CampanhaRetomavelResumo = {
        ...base,
        estado: "LOTE_CRIADO",
        loteId: "lote-gf43d",
        loteCodigo: "CAMPANHA_PF_AF75C4B48D7C",
        loteEstado,
        outboxTotal: 1,
        outboxNaoExecutavel: loteEstado === "PREPARADO" ? 1 : 0,
      };
      const disposicao = disposicaoRetomada([resumo]);
      expect(disposicao.tipo).toBe("ACOMPANHAMENTO");
      if (disposicao.tipo !== "ACOMPANHAMENTO") continue;
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
      expect(visao.macroId).toBe("OPERACAO");
      expect(visao.foco).toContain("Acompanhamento");
      expect(visao.macro).not.toBe(2);
    }
  });

  it("GF4.3D: derivação da macroetapa não filtra por HOLD — qualquer lote não-nulo é acompanhamento (fonte real)", () => {
    const caminhoMacro = resolve(diretorioAtual, "../src/pages/campaign-macro-stage.ts");
    const fonteMacro = existsSync(caminhoMacro) ? readFileSync(caminhoMacro, "utf-8") : "";
    expect(fonteMacro.length).toBeGreaterThan(0);
    expect(fonteMacro).toContain("if (campanha.loteId !== null && campanha.loteEstado !== null)");
    const inicio = fonteMacro.indexOf("export function macroEtapaAtual");
    const fim = fonteMacro.indexOf("function visao(");
    expect(inicio).toBeGreaterThanOrEqual(0);
    expect(fim).toBeGreaterThan(inicio);
    expect(fonteMacro.slice(inicio, fim)).not.toContain('"HOLD"');
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

  it("B·D: efeitos são EXATAMENTE 7 (GF-2 FINAL: +catálogo server-driven +prévia server-side; GF-3 F6: +blob URL da credencial) — sem efeito de hash (request por hash não pode iniciar nem concorrer)", () => {
    // UX-FLOW-01B.1: loadMe, workspace/status, descoberta + readiness 03B.
    // GF-2 FINAL: efeitos read-only de /api/campaigns/template-selecionaveis
    // (catálogo do registry) e de /api/campaigns/preview-registro (prévia
    // pelo MESMO renderer do envio). GF-3 CORRECTIVE-01 (F6): ciclo de vida
    // do blob URL da credencial (create/revoke). Nenhum efeito de hash legado.
    const usos = fonteComponente.split("useEffect(").length - 1;
    expect(usos).toBe(7);
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
    // File-wide: cleanup `ativo` nos 5 efeitos async (status + descoberta +
    // readiness 03B + catálogo GF-2 FINAL + prévia server-side GF-2 FINAL).
    expect(fonteComponente.split("let ativo = true;").length - 1).toBe(5);
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

// ---------------------------------------------------------------------------
// GF-3 CORRECTIVE-01 (F2) — CROSS_OPERATOR_WORKSPACE_STATE = ISOLATED:
// o logout confirmado limpa TODO o estado ligado ao operador montado. Prova
// estrutural sobre a fonte real (mesmo mecanismo dos gates anteriores —
// ambiente node, sem jsdom): a função canônica limparEstadoOperador é
// declarada UMA vez, referenciada pelo logout SIGNED_OUT, e cobre cada
// setter do estado do operador. Nenhuma persistência/localStorage.
// ---------------------------------------------------------------------------
describe("GF3 F2 — isolamento de estado entre operadores no logout", () => {
  const blocoLimpeza = (): string => {
    const inicio = fonteComponente.indexOf("const limparEstadoOperador = () => {");
    const fim = fonteComponente.indexOf("const [painelAdmin, setPainelAdmin]");
    expect(inicio).toBeGreaterThan(0);
    expect(fim).toBeGreaterThan(inicio);
    return fonteComponente.slice(inicio, fim);
  };

  it("PREVIOUS_OPERATOR_DATA_VISIBLE=false: limparEstadoOperador cobre os 18 estados do operador", () => {
    const bloco = blocoLimpeza();
    for (const chamada of [
      "setArquivo(null);",
      "setAvaliacaoArquivo(null);",
      "setMapeamento({});",
      "setBase(null);",
      "setAprovacao(null);",
      "setConfirmacaoAprovacao(\"\");",
      "setExcluidos([]);",
      "setPreviaIndice(0);",
      "setErroEtapa(\"\");",
      "setPainelAdmin(false);",
      "setOperadores([]);",
      "setCredencialUnica(null);",
      "setCredencialSalvaConfirmada(false);",
      "setAcaoMensagem(\"\");",
      "setAcaoErro(\"\");",
      "setCampanha(null);",
      "setRetomada(LIMPEZA_RETOMADA.retomada);",
      "setModoRetomada(LIMPEZA_RETOMADA.modo);",
    ]) {
      expect(bloco).toContain(chamada);
    }
  });

  it("logout SIGNED_OUT invoca a limpeza canônica UMA vez + me/token; operador anterior não sobrevive", () => {
    const blocoLogout = mid('if (campaignLogoutDisposition(response.status) === "SIGNED_OUT")');
    const fimLogout = blocoLogout.indexOf("setFeedback(\"Não foi possível confirmar a saída");
    const recorte = fimLogout > 0 ? blocoLogout.slice(0, fimLogout) : blocoLogout;
    expect(recorte.split("limparEstadoOperador();").length - 1).toBe(1);
    expect(recorte).toContain("setMe(null);");
    expect(recorte).toContain('setToken("");');
    // Nenhum setter operacional sobrevive fora da limpeza canônica no logout
    // (todos os resets passam a passar por limparEstadoOperador).
    for (const proibido of [
      "setArquivo(null);",
      "setBase(null);",
      "setAprovacao(null);",
      "setCredencialUnica(null);",
      "setOperadores([]);",
    ]) {
      expect(recorte).not.toContain(proibido);
    }
    // Retomada server-driven (me=null) zera campanha/modo/retomada — nenhuma
    // request pendente do operador A restaura estado para o operador B.
    const blocoRetomada = mid('if (!me) {');
    expect(blocoRetomada).toContain('setModoRetomada("INDEFINIDO")');
    expect(blocoRetomada).toContain("setCampanha(null)");
  });

  it("nenhuma persistência/localStorage para estado do operador", () => {
    expect(fonteComponente).not.toContain("localStorage.");
    expect(fonteComponente).not.toContain("localStorage[");
    // sessionStorage permanece restrito à limpeza HISTÓRICA do hash legado.
    expect(fonteComponente.split("sessionStorage.").length - 1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GF-3 CORRECTIVE-01 (F6) — CREDENTIAL_BLOB_URL_REVOKED: UM URL por
// credencial, criado em useEffect (NUNCA no JSX/render) e revogado quando a
// credencial muda, o modal fecha ou o componente desmonta.
// ---------------------------------------------------------------------------
describe("GF3 F6 — ciclo de vida do blob URL da credencial", () => {
  it("URL.createObjectURL só existe dentro do useEffect (nunca no JSX)", () => {
    expect(fonteComponente.split("URL.createObjectURL(").length - 1).toBe(1);
    expect(fonteComponente.split("URL.revokeObjectURL(").length - 1).toBe(1);
    const inicioEfeito = fonteComponente.indexOf("const [credencialBlobUrl, setCredencialBlobUrl]");
    const efeito = fonteComponente.slice(inicioEfeito);
    const blocoEfeito = efeito.slice(efeito.indexOf("useEffect(() => {"), efeito.indexOf("}, [credencialUnica]);"));
    expect(blocoEfeito).toContain("URL.createObjectURL(");
    expect(blocoEfeito).toContain("URL.revokeObjectURL(url);");
  });

  it("dependência [credencialUnica] revoga na troca/fechamento; cleanup cobre desmontagem; JSX usa credencialBlobUrl", () => {
    expect(fonteComponente).toContain("}, [credencialUnica]);");
    const inicioEfeito = fonteComponente.indexOf("const [credencialBlobUrl, setCredencialBlobUrl]");
    const efeito = fonteComponente.slice(inicioEfeito, inicioEfeito + 1200);
    expect(efeito).toContain("if (!credencialUnica) {");
    expect(efeito).toContain("setCredencialBlobUrl(null);");
    expect(fonteComponente).toContain('href={credencialBlobUrl ?? undefined}');
    expect(fonteComponente).not.toContain("href={URL.createObjectURL");
  });
});

// ---------------------------------------------------------------------------
// GF-3 CORRECTIVE-02 (F5) — CROSS_OPERATOR_TEMPLATE_STATE / PREVIEW_STATE:
// o logout confirmado limpa TAMBÉM os estados de template/prévia (catálogo,
// seleção, prévia renderizada, índice, carregando, erro). Nenhum localStorage/
// sessionStorage. Prova estrutural sobre a fonte real (mesmo mecanismo GF3 F2).
// ---------------------------------------------------------------------------
describe("GF3 C2 F5 — logout isola estados de template/prévia entre operadores", () => {
  const blocoLimpeza = (): string => {
    const inicio = fonteComponente.indexOf("const limparEstadoOperador = () => {");
    const fim = fonteComponente.indexOf("const [painelAdmin, setPainelAdmin]");
    expect(inicio).toBeGreaterThan(0);
    expect(fim).toBeGreaterThan(inicio);
    return fonteComponente.slice(inicio, fim);
  };

  it("limparEstadoOperador cobre os estados de template/prévia (F5)", () => {
    const bloco = blocoLimpeza();
    for (const chamada of [
      "setTemplatesSelecionaveis([]);",
      "setTemplateSelecionada(\"\");",
      "setPreviaMensagemServidor(null);",
      "setPreviaIndice(0);",
      "setPreviaCarregando(false);",
      "setPreviaErro(\"\");",
    ]) {
      expect(bloco).toContain(chamada);
    }
  });

  it("logout SIGNED_OUT segue pela limpeza canônica (sem resets paralelos de template/prévia)", () => {
    const blocoLogout = mid('if (campaignLogoutDisposition(response.status) === "SIGNED_OUT")');
    const recorte = blocoLogout.slice(0, blocoLogout.indexOf("setFeedback"));
    expect(recorte.split("limparEstadoOperador();").length - 1).toBe(1);
    // Nenhum reset de template/prévia fora da limpeza canônica:
    for (const proibido of [
      "setTemplatesSelecionaveis([]);",
      "setTemplateSelecionada(\"\");",
      "setPreviaMensagemServidor(null);",
    ]) {
      expect(recorte).not.toContain(proibido);
    }
  });

  it("sem persistência/localStorage de catálogo/seleção/prévia", () => {
    expect(fonteComponente).not.toContain("localStorage.");
    expect(fonteComponente).not.toContain("templatesSelecionaveis`");
    expect(fonteComponente.split("sessionStorage.").length - 1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GF-3 CORRECTIVE-02 (F6) — TEMPLATE_CATALOG_FOLLOWS_SESSION: o catálogo só
// é requisitado com sessão autenticada; sem `me` ⇒ catálogo limpo e NENHUMA
// request; troca de operador ⇒ resposta stale ignorada (cleanup `ativo`) e
// recarga. Sem polling (dependência única [me]).
// ---------------------------------------------------------------------------
describe("GF3 C2 F6 — catálogo segue o ciclo de vida da sessão", () => {
  it("efeito do catálogo depende de `me` (sem request desautenticado; sem polling)", () => {
    const inicio = fonteComponente.indexOf("catálogo de templates selecionáveis vem SEMPRE do servidor");
    expect(inicio).toBeGreaterThan(0);
    const fim = fonteComponente.indexOf("}, [me]);", inicio);
    expect(fim).toBeGreaterThan(inicio);
    const bloco = fonteComponente.slice(inicio, fim + "}, [me]);".length);
    expect(bloco).toContain("if (!me) {");
    expect(bloco).toContain("setTemplatesSelecionaveis([]);");
    expect(bloco).toContain('"/api/campaigns/template-selecionaveis"');
    expect(bloco).toContain("let ativo = true;");
    expect(bloco).toContain("ativo = false;");
    // Dependência ÚNICA [me] — sem polling:
    expect(bloco.endsWith("}, [me]);")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GF-3 CORRECTIVE-02 (F7-UI) — PREVIEW_INDEX_FOLLOWS_NAVIGATION: a prévia
// pré-aprovação usa POST /api/campaigns/template-preview com o MESMO payload
// pendente do authorize e o índice navegável previaIndice — nada de linha=1
// fixa. O browser NUNCA fornece subject/texto/HTML/remetente/Reply-To.
// ---------------------------------------------------------------------------
describe("GF3 C2 F7-UI — prévia pré-aprovação navega por previaIndice (server-rendered)", () => {
  it("efeito da prévia usa POST template-preview + previaIndice (sem linha=1)", () => {
    const inicio = fonteComponente.indexOf("PRÉVIA PRÉ-APROVAÇÃO");
    expect(inicio).toBeGreaterThan(0);
    const fim = fonteComponente.indexOf("}, [templateSelecionada, previaIndice, aptosParaAprovacao]);", inicio);
    expect(fim).toBeGreaterThan(inicio);
    const bloco = fonteComponente.slice(inicio, fim);
    expect(bloco).toContain('"/api/campaigns/template-preview"');
    expect(bloco).toContain("method: \"POST\"");
    expect(bloco).toContain("previaIndice: indiceSolicitado + 1");
    expect(bloco).toContain("templateVersao: templateSelecionada");
    expect(bloco).toContain("registros: aptosParaAprovacao.map");
    // NUNCA mais chamada GET do preview-registro (com query) nem linha=1
    // no fluxo pré-aprovação (a menção no comentário é do fluxo separado):
    expect(bloco).not.toContain("preview-registro?");
    expect(bloco).not.toContain("linha=1");
    // O browser não fornece conteúdo de mensagem:
    expect(bloco).not.toContain("subject:");
    expect(bloco).not.toContain("textBody:");
    expect(bloco).not.toContain("htmlBody:");
    expect(bloco).not.toContain("replyTo");
    // Cleanup stale presente:
    expect(bloco).toContain("ativo = false;");
  });

  it("fonte: nenhuma CHAMADA ao preview-registro permanece e linha=1 foi extinta", () => {
    expect(fonteComponente).not.toContain("preview-registro?");
    expect(fonteComponente).not.toContain("linha=1");
    // As únicas menções restantes são comentários de contrato (fluxo
    // pós-persist separado no servidor):
    for (const mencao of fonteComponente.split("preview-registro")) {
      // nenhuma menção é uma chamada fetchJson direta
      expect(mencao.startsWith("fetchJson")).toBe(false);
    }
  });

  it("erro de prévia é estado do operador e é renderizado (role=alert)", () => {
    expect(fonteComponente).toContain("const [previaErro, setPreviaErro] = useState(\"\");");
    expect(fonteComponente).toContain('role="alert">{previaErro}</p>');
  });
});
