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
