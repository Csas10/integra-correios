/**
 * GF5.2 — GOVERNED BATCH CONTROL + READINESS FOUNDATION (STRICT ZERO SEND
 * NESTE GATE; nenhuma rota HTTP de envio de lote é exposta aqui).
 *
 * Autoridade da CAMPANHA preservada: ownership, papéis (EXECUTOR), lote,
 * outbox_campanha, snapshot congelado, hash de aprovação, provas,
 * idempotência, claim atômico, auditoria e settlement. A plataforma de
 * e-mail CONSOLIDADA (GF5.1) fornece APENAS transporte/gateway/OAuth —
 * o provider chega ao item EXCLUSIVAMENTE via executeAttemptCampanha()
 * (nunca batch → provider.enviar direto; nunca worker genérico; nunca
 * outbox_email — DUAL_EXECUTABLE_OUTBOX=false).
 *
 * PREFLIGHT (preflightLoteCampanha): ESTRITAMENTE READ-ONLY — zero claim,
 * zero mutação, zero evento, zero token decrypt/refresh, zero rede. Resolve
 * server-side: ownership, lote, contagens por estado, autorização humana,
 * PROVA DURÁVEL de canário ENVIADO (EXEC_SETTLEMENT no item canário),
 * ENFILEIRADO pendente (crash-after-claim), ambiguidade não resolvida
 * (EXEC_AMBIGUO), política (batchSendEnabled ∧ canExecute ∧ realSendEnabled)
 * e proofKey. Sem PII/e-mail/fingerprint/token/HMAC na saída.
 *
 * EXECUÇÃO (executarLoteCampanha): CONCURRENCY=1, ordem
 * outbox_campanha.ordem ASC, apenas itens PREPARADO, um
 * executeAttemptCampanha() por item (provas server-side derivadas do MESMO
 * compositor canônico do preflight do canário), PARADA CONSERVADORA em
 * qualquer não-ENVIADO/NAO_CLAIMADO inesperado/erro — AMBIGUO interrompe
 * imediatamente; AUTO_RETRY=false; itens restantes permanecem PREPARADO.
 * Itens terminais (ENVIADO/FALHOU) nunca são selecionados — o canário já
 * enviado NUNCA é reenviado (CANARY_RESEND_IN_BATCH=false).
 */
import { randomUUID } from "node:crypto";
import type { CampanhaPool } from "./campaign-control.js";
import {
  ACAO_AUTORIZADA_EXECUCAO,
  CODIGO_EVENTO_ATIVACAO,
  CODIGO_EVENTO_AUTORIZACAO,
  CODIGO_EVENTO_CANARIO,
  emitirProvasServerSideCampanha,
  lerConfiguracaoChaveProvaCampanha,
} from "./campaign-control.js";
import {
  executeAttemptCampanha,
  type ProvedorEnvioCampanha,
  type ProvasAutorizacaoExecucao,
  type ResultadoTentativaExecucao,
} from "./campaign-execution.js";
import type { PfUpdateCampaignPolicy } from "./campaigns.js";
import {
  avaliarReadinessOauthCanario,
  provedorWiringReady,
} from "./campaign-canary.js";

// ---------------------------------------------------------------------------
// PREFLIGHT READ-ONLY — bloqueios sanitizados estáveis
// ---------------------------------------------------------------------------

export const BLOQUEIOS_LOTE = {
  PAPEL: "OPERATOR_ROLE_FORBIDDEN",
  BATCH_DESARMADO: "BATCH_SEND_DISABLED",
  EXECUCAO_DESARMADA: "CAMPAIGN_EXECUTE_DISABLED",
  REAL_SEND_DESARMADO: "REAL_SEND_DISABLED",
  LOTE_NAO_ATIVO: "LOTE_NAO_ATIVO",
  LOTE_VAZIO: "LOTE_SEM_ITENS",
  AUTORIZACAO_AUSENTE: "AUTORIZACAO_HUMANA_AUSENTE",
  PROVA_KEY_INDISPONIVEL: "PROOF_KEY_UNAVAILABLE",
  ATIVACAO_AUSENTE: "ATIVACAO_AUSENTE",
  CANARIO_NAO_ENVIADO: "CANARY_NOT_SUCCESSFULLY_ADJUDICATED",
  ENFILEIRADO_PENDENTE: "BATCH_EXECUTION_IN_PROGRESS_OR_UNRESOLVED",
  AMBIGUIDADE_NAO_RESOLVIDA: "BATCH_AMBIGUITY_UNRESOLVED",
  NADA_A_EXECUTAR: "BATCH_SEM_ITENS_PREPARADOS",
  // GF5.2A — mail readiness consolidada (mesmos códigos do canário).
  OAUTH_CONFIG: "OAUTH_CONFIGURATION_REQUIRED",
  OAUTH_CONEXAO: "OAUTH_NOT_CONNECTED",
  OAUTH_CONTA_AUSENTE: "OAUTH_EXPECTED_ACCOUNT_MISSING",
  OAUTH_CONTA_DIVERGENTE: "OAUTH_ACCOUNT_MISMATCH",
  OAUTH_CRIPTO: "OAUTH_ENCRYPTION_KEY_MISSING",
  WIRING: "PROVIDER_WIRING_NOT_READY",
} as const;

export interface EntradaPreflightLote {
  readonly operatorId: string;
  readonly campanhaId: string;
  /** Papéis do operador resolvidos SERVER-SIDE pela sessão. */
  readonly papeis: readonly string[];
  readonly politica: PfUpdateCampaignPolicy;
  /**
   * GF5.2A — contexto server-side: o fingerprinter HMAC canônico para o
   * casamento conta esperada × persistida. NUNCA derivado/aceito do
   * browser; a ausência fail-closed bloqueia OAUTH_* em vez de construir
   * fingerprinter com chave vazia.
   */
  readonly contexto?: {
    readonly fingerprinter?: import("@integra-correios/persistence").HmacSha256Fingerprinter;
  };
}

export type ResultadoPreflightLote =
  | {
      readonly elegivel: true;
      readonly loteCampanhaId: string;
      readonly loteCodigo: string;
      readonly totalItens: number;
      readonly contagemPorEstado: Readonly<Record<string, number>>;
      readonly preparados: number;
      readonly enviados: number;
      /** Referência server-side para provas por item (derivada do evento). */
      readonly referenciaAutorizacao: string;
      /** Itens elegíveis: {id, ordem} ASC — context sanitizado (sem PII). */
      readonly itensElegiveis: readonly { readonly id: string; readonly ordem: number }[];
    }
  | { readonly elegivel: false; readonly bloqueios: readonly string[] };

/**
 * Verificação DURÁVEL do canário: o item selecionado pelo evento
 * CAMPANHA_CANARIO_SELECIONADO deve existir, pertencer a este lote,
 * estar ENVIADO e ter evidência durável de sucesso consistente com o
 * settlement atual (EXEC_RECEIPT + EXEC_SETTLEMENT no mesmo item).
 * "Selecionado" NÃO equivale a "enviado com sucesso".
 */
async function canarioComSucessoDuravel(
  pool: Pick<CampanhaPool, "query">,
  loteCampanhaId: string,
): Promise<boolean> {
  const selecao = await pool.query(
    `SELECT e.metadados->>'item_id' AS item_id
       FROM evento_auditoria e
      WHERE e.agregado_tipo = 'CAMPANHA_EXECUCAO'
        AND e.agregado_id = $1
        AND e.tipo = $2
      ORDER BY e.sequencia DESC
      LIMIT 1`,
    [loteCampanhaId, CODIGO_EVENTO_CANARIO],
  );
  const itemId = (selecao.rows[0] as { item_id?: unknown } | undefined)?.item_id;
  if (typeof itemId !== "string" || !itemId) return false;
  const item = await pool.query(
    `SELECT i.id, i.estado, i.lote_campanha_id
       FROM outbox_campanha i
      WHERE i.id = $1
      LIMIT 1`,
    [itemId],
  );
  const linha = item.rows[0] as
    | { id: string; estado: string; lote_campanha_id: string }
    | undefined;
  if (!linha) return false;
  if (linha.lote_campanha_id !== loteCampanhaId) return false;
  if (linha.estado !== "ENVIADO") return false;
  // Evidência durável de sucesso consistente com o settlement canônico.
  const eventos = await pool.query(
    `SELECT tipo, count(*)::int AS total
       FROM evento_auditoria
      WHERE agregado_tipo = 'CAMPANHA_EXECUCAO'
        AND agregado_id = $1
        AND tipo IN ('EXEC_RECEIPT', 'EXEC_SETTLEMENT')
      GROUP BY tipo`,
    [itemId],
  );
  const porTipo: Record<string, number> = {};
  for (const linhaEvento of eventos.rows as { tipo: string; total: number }[]) {
    porTipo[linhaEvento.tipo] = Number(linhaEvento.total);
  }
  return (porTipo["EXEC_RECEIPT"] ?? 0) >= 1 && (porTipo["EXEC_SETTLEMENT"] ?? 0) >= 1;
}

/**
 * Preflight READ-ONLY do lote controlado. Nenhuma escrita; nenhum token;
 * nenhuma rede. Toda autoridade é resolvida server-side.
 */
export async function preflightLoteCampanha(
  pool: Pick<CampanhaPool, "query">,
  entrada: EntradaPreflightLote,
): Promise<ResultadoPreflightLote> {
  const bloqueios: string[] = [];
  const { politica } = entrada;

  // 1. Papel (autoridade da sessão; mesma semântica da rota de envio).
  const executor = entrada.papeis.includes("EXECUTOR");
  if (!executor) bloqueios.push(BLOQUEIOS_LOTE.PAPEL);

  // 2. Política (três gates INDEPENDENTES; batch NÃO herda o canário).
  if (!politica.batchSendEnabled) bloqueios.push(BLOQUEIOS_LOTE.BATCH_DESARMADO);
  if (!politica.canExecute) bloqueios.push(BLOQUEIOS_LOTE.EXECUCAO_DESARMADA);
  if (!politica.realSendEnabled) bloqueios.push(BLOQUEIOS_LOTE.REAL_SEND_DESARMADO);

  // 3. Lote (resolvido server-side por ownership).
  const lote = await pool.query(
    `SELECT l.id, l.codigo, l.estado, l.total_itens,
            (SELECT 1 FROM evento_auditoria e
              WHERE e.agregado_tipo = 'CAMPANHA_EXECUCAO'
                AND e.agregado_id = l.id AND e.tipo = $2
              LIMIT 1) AS ativacao_presente
       FROM lote_campanha l
       JOIN campanha_persistida c ON c.id = l.campanha_id
      WHERE c.id = $1 AND c.operator_id = $3
      LIMIT 1`,
    [entrada.campanhaId, CODIGO_EVENTO_ATIVACAO, entrada.operatorId],
  );
  const linhaLote = lote.rows[0] as
    | {
        id: string;
        codigo: string;
        estado: string;
        total_itens: number;
        ativacao_presente: unknown;
      }
    | undefined;
  if (!linhaLote) {
    return { elegivel: false, bloqueios: bloqueios.length > 0 ? bloqueios : [BLOQUEIOS_LOTE.LOTE_NAO_ATIVO] };
  }
  if (linhaLote.estado !== "ATIVO") bloqueios.push(BLOQUEIOS_LOTE.LOTE_NAO_ATIVO);
  if (Number(linhaLote.total_itens) <= 0) bloqueios.push(BLOQUEIOS_LOTE.LOTE_VAZIO);
  if (!linhaLote.ativacao_presente) bloqueios.push(BLOQUEIOS_LOTE.ATIVACAO_AUSENTE);

  // 4. Autorização humana vigente (evento auditado no lote).
  const autorizacao = await pool.query(
    `SELECT id FROM evento_auditoria
      WHERE agregado_tipo = 'CAMPANHA_EXECUCAO'
        AND agregado_id = $1 AND tipo = $2
      ORDER BY sequencia DESC LIMIT 1`,
    [linhaLote.id, CODIGO_EVENTO_AUTORIZACAO],
  );
  const referenciaAutorizacao = (autorizacao.rows[0] as { id: string } | undefined)?.id ?? "";
  if (!referenciaAutorizacao) bloqueios.push(BLOQUEIOS_LOTE.AUTORIZACAO_AUSENTE);

  // 5. Infraestrutura de provas (compositor canônico server-side).
  if (!lerConfiguracaoChaveProvaCampanha().proofKeyReady) {
    bloqueios.push(BLOQUEIOS_LOTE.PROVA_KEY_INDISPONIVEL);
  }

  // 5b. GF5.2A — READINESS da plataforma de e-mail CONSOLIDADA, reutilizando
  // EXATAMENTE os primitivos canônicos do canário (nenhuma segunda
  // implementação OAuth): avaliarReadinessOauthCanario (ESTRITAMENTE
  // read-only: zero token decrypt/refresh, zero Google/Gmail, zero provider)
  // + provedorWiringReady. Sem fingerprinter canônico ⇒ fail-closed no
  // casamento de conta (nunca fingerprinter de chave vazia).
  const oauth = await avaliarReadinessOauthCanario(pool, entrada.contexto?.fingerprinter);
  if (!oauth.oauthConfigurationReady) bloqueios.push(BLOQUEIOS_LOTE.OAUTH_CONFIG);
  if (!oauth.oauthExpectedAccountConfigured) bloqueios.push(BLOQUEIOS_LOTE.OAUTH_CONTA_AUSENTE);
  if (!oauth.oauthEncryptionConfigurationReady) bloqueios.push(BLOQUEIOS_LOTE.OAUTH_CRIPTO);
  if (!oauth.oauthConnectionStored) bloqueios.push(BLOQUEIOS_LOTE.OAUTH_CONEXAO);
  else if (!oauth.oauthStoredAccountMatchesExpected) bloqueios.push(BLOQUEIOS_LOTE.OAUTH_CONTA_DIVERGENTE);
  if (!provedorWiringReady()) bloqueios.push(BLOQUEIOS_LOTE.WIRING);

  // 6. Canário ENVIADO com evidência durável (selecionado ≠ enviado).
  if (!(await canarioComSucessoDuravel(pool, linhaLote.id))) {
    bloqueios.push(BLOQUEIOS_LOTE.CANARIO_NAO_ENVIADO);
  }

  // 7–9. Estado da outbox: ENFILEIRADO pendente bloqueia (crash-after-claim);
  // ambiguidade não resolvida bloqueia (fail-closed, sem inventar resolução).
  const contagem = await pool.query(
    `SELECT estado, count(*)::int AS total FROM outbox_campanha
      WHERE lote_campanha_id = $1 GROUP BY estado`,
    [linhaLote.id],
  );
  const contagemPorEstado: Record<string, number> = {};
  for (const linhaContagem of contagem.rows as { estado: string; total: number }[]) {
    contagemPorEstado[linhaContagem.estado] = Number(linhaContagem.total);
  }
  if ((contagemPorEstado["ENFILEIRADO"] ?? 0) > 0) {
    bloqueios.push(BLOQUEIOS_LOTE.ENFILEIRADO_PENDENTE);
  }
  const ambiguos = await pool.query(
    `SELECT i.id FROM outbox_campanha i
       JOIN evento_auditoria e ON e.agregado_tipo = 'CAMPANHA_EXECUCAO'
        AND e.agregado_id = i.id AND e.tipo = 'EXEC_AMBIGUO'
      WHERE i.lote_campanha_id = $1
      LIMIT 1`,
    [linhaLote.id],
  );
  if (ambiguos.rows.length > 0) bloqueios.push(BLOQUEIOS_LOTE.AMBIGUIDADE_NAO_RESOLVIDA);

  const preparados = contagemPorEstado["PREPARADO"] ?? 0;
  if (preparados <= 0) bloqueios.push(BLOQUEIOS_LOTE.NADA_A_EXECUTAR);

  if (bloqueios.length > 0) {
    return { elegivel: false, bloqueios };
  }

  // 10. Itens elegíveis (contexto server-side; ordem ASC; sem PII).
  const itens = await pool.query(
    `SELECT i.id, i.ordem FROM outbox_campanha i
      WHERE i.lote_campanha_id = $1 AND i.estado = 'PREPARADO'
      ORDER BY i.ordem ASC`,
    [linhaLote.id],
  );
  const itensElegiveis = (itens.rows as { id: string; ordem: number }[]).map((linha) => ({
    id: linha.id,
    ordem: Number(linha.ordem),
  }));

  return {
    elegivel: true,
    loteCampanhaId: linhaLote.id,
    loteCodigo: linhaLote.codigo,
    totalItens: Number(linhaLote.total_itens),
    contagemPorEstado,
    preparados,
    enviados: contagemPorEstado["ENVIADO"] ?? 0,
    referenciaAutorizacao,
    itensElegiveis,
  };
}

// ---------------------------------------------------------------------------
// EXECUÇÃO DO LOTE — sequencial, stop conservador, zero retry
// ---------------------------------------------------------------------------

export interface FornecedorProvedoresLote {
  /** Fábrica server-side (GF5.1): provedor consolidado por campanha. */
  readonly provedorParaCampanha: (campanhaId: string) => ProvedorEnvioCampanha;
}

export type ResultadoExecucaoLote = {
  readonly campanhaId: string;
  readonly loteCampanhaId: string;
  readonly resultado: "CONCLUIDO" | "INTERROMPIDO" | "BLOQUEADO";
  readonly totalItens: number;
  readonly preparadosInicio: number;
  readonly enviadosAntes: number;
  readonly processadosNestaExecucao: number;
  readonly enviadosNestaExecucao: number;
  readonly falhasNestaExecucao: number;
  readonly restantesPreparados: number;
  readonly motivoInterrupcao?: string;
  /** Ordem do último item processado (sanitizado; sem PII). */
  readonly ultimaOrdemProcessada?: number;
};

/**
 * Execução controlada do lote (CONCURRENCY=1). O provider NUNCA é chamado
 * diretamente: cada item passa EXATAMENTE uma vez por executeAttemptCampanha
 * (claim atômico + provas server-side + settlement + auditoria). Qualquer
 * resultado não-ENVIADO interrompe o lote (stop conservador); AMBIGUO
 * interrompe imediatamente; nenhum item é reenfileirado; nenhum retry.
 */
export async function executarLoteCampanha(
  pool: CampanhaPool,
  entrada: {
    readonly operatorId: string;
    readonly campanhaId: string;
    readonly papeis: readonly string[];
    readonly politica: PfUpdateCampaignPolicy;
    /** GF5.2A — mesmo contexto do preflight (fingerprinter canônico). */
    readonly contexto?: {
      readonly fingerprinter?: import("@integra-correios/persistence").HmacSha256Fingerprinter;
    };
    readonly fornecedor: FornecedorProvedoresLote;
    /** Injetável para testes; default = compositor canônico server-side. */
    readonly emitirProvas?: typeof emitirProvasServerSideCampanha;
    /**
     * Injetável para testes; default = a autoridade canônica
     * executeAttemptCampanha. A produção NUNCA injeta: todo envio passa
     * EXATAMENTE por executeAttemptCampanha (claim/provas/settlement).
     */
    readonly executarTentativa?: typeof executeAttemptCampanha;
  },
): Promise<ResultadoExecucaoLote> {
  // 1–2. Preflight canônico: bloqueado ⇒ ZERO claim/provider.
  const preflight = await preflightLoteCampanha(pool, {
    operatorId: entrada.operatorId,
    campanhaId: entrada.campanhaId,
    papeis: entrada.papeis,
    politica: entrada.politica,
    ...(entrada.contexto ? { contexto: entrada.contexto } : {}),
  });
  if (!preflight.elegivel) {
    return {
      campanhaId: entrada.campanhaId,
      loteCampanhaId: "",
      resultado: "BLOQUEADO",
      totalItens: 0,
      preparadosInicio: 0,
      enviadosAntes: 0,
      processadosNestaExecucao: 0,
      enviadosNestaExecucao: 0,
      falhasNestaExecucao: 0,
      restantesPreparados: 0,
      motivoInterrupcao: preflight.bloqueios.join(","),
    };
  }

  const emitirProvas = entrada.emitirProvas ?? emitirProvasServerSideCampanha;
  const provider = entrada.fornecedor.provedorParaCampanha(entrada.campanhaId);

  const preparadosInicio = preflight.preparados;
  let enviadosNestaExecucao = 0;
  let falhasNestaExecucao = 0;
  let processadosNestaExecucao = 0;
  let motivoInterrupcao: string | undefined;
  let ultimaOrdemProcessada: number | undefined;
  let restantesPreparados = preparadosInicio;

  // 3–7. Sequencial estrito (sem Promise.all, sem worker, sem scheduler).
  for (const item of preflight.itensElegiveis) {
    // Provas server-side por item (mesmo compositor canônico do canário;
    // deriva lote/item do estado durável — nada do cliente).
    const provasResultado = await emitirProvas(
      pool,
      {
        operatorId: entrada.operatorId,
        campanhaId: entrada.campanhaId,
        loteCampanhaId: preflight.loteCampanhaId,
        itemId: item.id,
      },
      {},
    );
    if (!provasResultado) {
      motivoInterrupcao = "PROVAS_INDISPONIVEIS";
      falhasNestaExecucao += 0; // item NUNCA foi claimed — permanece PREPARADO
      break;
    }
    if (!provasResultado.provas.recipientProofVerified) {
      motivoInterrupcao = "PROVA_DESTINATARIO_AUSENTE";
      break;
    }
    if (!provasResultado.provas.humanAuthorizationVerified) {
      motivoInterrupcao = "AUTORIZACAO_HUMANA_AUSENTE";
      break;
    }
    const provas: ProvasAutorizacaoExecucao = provasResultado.provas;

    // EXATAMENTE uma tentativa por item; nenhuma chamada direta ao provider.
    let saida: ResultadoTentativaExecucao;
    const executarTentativa = entrada.executarTentativa ?? executeAttemptCampanha;
    try {
      saida = await executarTentativa(pool, {
        operatorId: entrada.operatorId,
        campanhaId: entrada.campanhaId,
        loteCampanhaId: preflight.loteCampanhaId,
        itemId: item.id,
        politica: entrada.politica,
        provas,
        provider,
      });
    } catch {
      // Inconsistência de settlement/erro inesperado: para conservadoramente.
      motivoInterrupcao = "EXECUCAO_INCONSISTENTE";
      break;
    }

    processadosNestaExecucao += 1;
    ultimaOrdemProcessada = item.ordem;

    if (saida.resultado === "ENVIADO") {
      enviadosNestaExecucao += 1;
      restantesPreparados -= 1;
      continue; // único caso que prossegue ao próximo item
    }
    if (saida.resultado === "NAO_CLAIMADO") {
      // Corrida/inconsistência inesperada (preflight garantia PREPARADO):
      // stop conservador — sem reenfileirar, sem retry.
      motivoInterrupcao = "NAO_CLAIMADO_INESPERADO";
      falhasNestaExecucao += 0;
      break;
    }
    // FALHA_PRE_PROVIDER / FALHA_DEFINITIVA / AMBIGUO: terminaliza o item
    // (feito dentro de executeAttemptCampanha) e PARA o lote.
    falhasNestaExecucao += 1;
    restantesPreparados -= 1;
    motivoInterrupcao =
      saida.resultado === "AMBIGUO"
        ? "AMBIGUO_RECONCILIACAO_HUMANA"
        : `${saida.resultado}:${saida.motivo}`;
    break;
  }

  return {
    campanhaId: entrada.campanhaId,
    loteCampanhaId: preflight.loteCampanhaId,
    resultado:
      motivoInterrupcao === undefined
        ? "CONCLUIDO"
        : "INTERROMPIDO",
    totalItens: preflight.totalItens,
    preparadosInicio,
    enviadosAntes: preflight.enviados,
    processadosNestaExecucao,
    enviadosNestaExecucao,
    falhasNestaExecucao,
    restantesPreparados,
    ...(motivoInterrupcao === undefined ? {} : { motivoInterrupcao }),
    ...(ultimaOrdemProcessada === undefined ? {} : { ultimaOrdemProcessada }),
  };
}

/** Identidade do campo de provas autorizadas (contrato 03C.2A.5 preservado). */
export const ACAO_EXECUCAO_LOTE = ACAO_AUTORIZADA_EXECUCAO;

/** Nonce interno de composição (nunca exposto; utilitário para testes). */
export function nonceComposicaoLote(): string {
  return randomUUID();
}
