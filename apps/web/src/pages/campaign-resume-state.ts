/**
 * UX-FLOW-01B — Decisão PURA de retomada server-driven de campanha persistida.
 *
 * Débito CROSS_BROWSER_RESUME_DEPENDS_ON_SESSION_CONTEXT: a retomada antiga
 * dependia do hash no Session Storage — em outro navegador, campanha
 * persistida não era apresentada. Esta decisão consome EXCLUSIVAMENTE a
 * lista READ-ONLY do servidor (GET /api/campaigns/resumable, escopo
 * operator_id da sessão): nenhum requisito de hash prévio, nenhuma seleção
 * pelo cliente, nenhuma mutação.
 *
 * Política multi-campanha (explícita):
 *   · A retomada ABRE o foco da campanha mais recente (servidor devolve
 *     criada_em DESC — o cliente NÃO escolhe o alvo).
 *   · As demais permanecem listadas no acompanhamento para consulta
 *     read-only (sem trocar o foco silenciosamente).
 *
 * Sem persistência de rascunho nesta entrega: o que não está no PostgreSQL
 * (importação, mapeamento, revisão da sessão) NÃO é retomado.
 */

export interface CampanhaRetomavelResumo {
  readonly campanhaId: string;
  readonly estado: string;
  readonly hashAprovacao: string;
  readonly totalAprovados: number;
  readonly loteId: string | null;
  readonly loteCodigo: string | null;
  readonly loteEstado: string | null;
  readonly outboxTotal: number;
  readonly outboxNaoExecutavel: number;
  readonly criadaEm: string;
}

export type DisposicaoRetomada =
  /** Nada a retomar (ignoradas = 0) ou estado(s) não retomável(is). */
  | { readonly tipo: "SEM_RETOMADA"; readonly ignoradas: number }
  /** APROVADA sem lote → "Campanha pronta para preparar lote". */
  | { readonly tipo: "PREPARAR_LOTE"; readonly campanha: CampanhaRetomavelResumo; readonly totalRetomaveis: number }
  /** LOTE_CRIADO (lote HOLD) → "Operação e acompanhamento". */
  | { readonly tipo: "ACOMPANHAMENTO"; readonly campanha: CampanhaRetomavelResumo; readonly totalRetomaveis: number }
  /** Estado não retomável nesta entrega (ex.: CAMPAIGN_CANCELADA) → sem retomada. */
  | { readonly tipo: "SEM_RETOMADA"; readonly ignoradas: number };

/**
 * Decide a retomada a partir da lista server-driven (ordem criada_em DESC
 * GARANTIDA pelo servidor). Puro: mesma lista, mesma disposição.
 */
export function disposicaoRetomada(
  campanhas: readonly CampanhaRetomavelResumo[],
): DisposicaoRetomada {
  const primeira = campanhas[0];
  if (!primeira) return { tipo: "SEM_RETOMADA", ignoradas: 0 };
  const total = campanhas.length;
  if (primeira.loteId !== null) {
    return { tipo: "ACOMPANHAMENTO", campanha: primeira, totalRetomaveis: total };
  }
  if (primeira.estado === "APROVADA") {
    return { tipo: "PREPARAR_LOTE", campanha: primeira, totalRetomaveis: total };
  }
  return { tipo: "SEM_RETOMADA", ignoradas: total };
}
