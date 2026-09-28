/**
 * UX-FLOW-01B — Decisão PURA de retomada server-driven de campanha persistida.
 *
 * A decisão consome EXCLUSIVAMENTE a lista READ-ONLY do servidor
 * (GET /api/campaigns/resumable, escopo operator_id da sessão): nenhum
 * requisito de hash prévio, nenhuma seleção pelo cliente, nenhuma mutação.
 *
 * Contrato de cardinalidade (server-driven, sem escolha implícita):
 *   - EMPTY (0 retomáveis) → SEM_RETOMADA;
 *   - SINGLE (1 retomável) → foco ÚNICO autorizado pelo servidor
 *     (PREPARAR_LOTE ou ACOMPANHAMENTO);
 *   - MULTIPLE (2 ou mais) → SELECAO_EXPLICITA_NECESSARIA: NENHUMA campanha
 *     é escolhida aqui (nem a mais recente, nem a primeira linha). A UI
 *     lista os resumos autorizados e somente a ação humana do operador chama
 *     GET /api/campaigns/detail?campanhaId=... (aplicação via setCampanha).
 *
 * Resumo minimizado (corretivo): o hash de aprovação NÃO faz parte da lista
 * de descoberta — sai somente do detail autenticado após seleção explícita.
 *
 * Sem persistência de rascunho nesta entrega: o que não está no PostgreSQL
 * (importação, mapeamento, revisão da sessão) NÃO é retomado.
 */

export interface CampanhaRetomavelResumo {
  readonly campanhaId: string;
  readonly estado: string;
  readonly totalAprovados: number;
  readonly loteId: string | null;
  readonly loteCodigo: string | null;
  readonly loteEstado: string | null;
  readonly outboxTotal: number;
  readonly outboxNaoExecutavel: number;
  readonly criadaEm: string;
}

export type DisposicaoRetomada =
  /** Nada a retomar: EMPTY do servidor ou estado(s) não retomável(is). */
  | { readonly tipo: "SEM_RETOMADA"; readonly ignoradas: number }
  /** SINGLE APROVADA sem lote → Operação / preparar lote. */
  | { readonly tipo: "PREPARAR_LOTE"; readonly campanha: CampanhaRetomavelResumo; readonly totalRetomaveis: number }
  /** SINGLE LOTE_CRIADO (lote HOLD) → Operação / acompanhamento. */
  | { readonly tipo: "ACOMPANHAMENTO"; readonly campanha: CampanhaRetomavelResumo; readonly totalRetomaveis: number }
  /** 2+ retomáveis → NENHUMA escolha implícita: a lista aguarda ação humana. */
  | { readonly tipo: "SELECAO_EXPLICITA_NECESSARIA"; readonly totalRetomaveis: number };

/**
 * Decide a retomada a partir da lista server-driven. Puro: mesma lista,
 * mesma disposição. A cardinalidade é decidida pelo SERVIDOR (que já filtra
 * apenas estados retomáveis e nunca aplica limite do cliente à decisão);
 * esta função apenas reclassifica a lista autorizada — nunca inventa foco.
 */
export function disposicaoRetomada(
  campanhas: readonly CampanhaRetomavelResumo[],
): DisposicaoRetomada {
  const total = campanhas.length;
  const primeira = campanhas[0];
  if (!primeira) return { tipo: "SEM_RETOMADA", ignoradas: 0 };
  if (total >= 2) {
    // Contrato UX-FLOW-01B: com 2+ campanhas NÃO existe "abrir a mais
    // recente" — a UI mostra a lista e o operador escolhe explicitamente.
    return { tipo: "SELECAO_EXPLICITA_NECESSARIA", totalRetomaveis: total };
  }
  if (primeira.loteId !== null) {
    return { tipo: "ACOMPANHAMENTO", campanha: primeira, totalRetomaveis: total };
  }
  if (primeira.estado === "APROVADA") {
    return { tipo: "PREPARAR_LOTE", campanha: primeira, totalRetomaveis: total };
  }
  return { tipo: "SEM_RETOMADA", ignoradas: total };
}

// ---------------------------------------------------------------------------
// UX-FLOW-01B SERVER-DRIVEN RECOVERY AUTHORITY — corretivo
// LEGACY_HASH_RECOVERY_OVERWRITES_SERVER_DRIVEN_STATE: o gate de recuperação
// por hash (`recuperacaoPorHashPermitida`) e o efeito legado que o consumia
// foram REMOVIDOS. `/api/campaigns/resumable` + `/api/campaigns/detail` são a
// AUTORIDADE ÚNICA da recuperação autenticada:
//   · SINGLE → detail automático aplica a campanha;
//   · MULTIPLE → somente seleção explícita humana chama detail;
//   · EMPTY/INDEFINIDO → nenhuma recuperação.
// UX-FLOW-01B.1 DEAD HASH LIFECYCLE CLEANUP: o ciclo de recuperação por
// hash está EXTINTO — zero leituras e zero gravações de ic_campanha_hash
// no código corrente. A chave legado sobrevive EXCLUSIVAMENTE para a
// remoção histórica no logout (removeItem de resíduos de versões
// anteriores). O Session Storage NÃO é autoridade: /resumable + /detail
// são a única autoridade da retomada.
// Os únicos consumidores legítimos de /persisted são os fluxos de CRIAÇÃO
// (persistirCampanha / criarLoteCampanha), escopo explicitamente separado.
// ---------------------------------------------------------------------------

/** Modo determinado EXCLUSIVAMENTE pela descoberta (GET /api/campaigns/resumable). */
export type ModoDescobertaRetomada = "INDEFINIDO" | "EMPTY" | "SINGLE" | "MULTIPLE";

/**
 * Chave LEGADO do Session Storage (UX-FLOW-01B.1 DEAD HASH LIFECYCLE CLEANUP).
 * Não há leitura nem gravação desta chave no código corrente: ela existe
 * apenas para o logout REMOVER resíduos gravados por versões anteriores.
 * Não alimenta nenhuma recuperação.
 */
export const CHAVE_HASH_SESSAO = "ic_campanha_hash";
/** Reset local completo (logout): nenhum estado operacional sobrevive. */
export const LIMPEZA_RETOMADA = {
  chaveHashSessao: CHAVE_HASH_SESSAO,
  campanha: null,
  modo: "INDEFINIDO",
  retomada: { status: "indefinida" },
} as const;
