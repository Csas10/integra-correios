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
// CORRETIVO MULTIPLE / HASH RACE — coordenação determinística entre a
// descoberta server-driven (AUTORIDADE da retomada) e a recuperação legado
// por hash (conveniência de precisão). A recuperação por hash NUNCA é
// mecanismo paralelo de seleção:
//   · MULTIPLE sem seleção explícita → hash NÃO seleciona campanha;
//   · EMPTY → nenhuma campanha é reativada;
//   · SINGLE → hash converge para a MESMA campanha autorizada;
//   · MULTIPLE pós-seleção explícita → converge para a selecionada.
// Quando o modo muda, o efeito de hash re-executa e o cleanup cancela o
// /persisted em voo — uma resposta atrasada NÃO reativa campanha depois de
// a descoberta ter determinado o modo. Session Storage segue conveniência,
// nunca autoridade.
// ---------------------------------------------------------------------------

/** Modo determinado EXCLUSIVAMENTE pela descoberta (GET /api/campaigns/resumable). */
export type ModoDescobertaRetomada = "INDEFINIDO" | "EMPTY" | "SINGLE" | "MULTIPLE";

/** Ordem da autoridade (descoberta) para o mecanismo legado de hash. */
export type OrdemRetomada =
  /** 2+ retomáveis: hash NÃO seleciona — só clique humano (detail). */
  | { readonly ordem: "RESPEITAR_SELECAO" }
  /** 1 retomável: hash pode atuar — converge à MESMA campanha autorizada. */
  | { readonly ordem: "APLICAR_CAMPANHA" }
  /** 0 retomáveis: nenhuma campanha ativa — hash não reativa nada. */
  | { readonly ordem: "LIMPAR_SELECAO" };

/** Ordem derivada da cardinalidade total determinada pela descoberta. */
export function ordemRetomadaParaRecuperacaoPorHash(
  totalRetomaveis: number,
): OrdemRetomada {
  if (totalRetomaveis >= 2) return { ordem: "RESPEITAR_SELECAO" };
  if (totalRetomaveis === 1) return { ordem: "APLICAR_CAMPANHA" };
  return { ordem: "LIMPAR_SELECAO" };
}

export interface EstadoRetomadaLogado {
  /** Modo determinado pela descoberta (resumable) — a autoridade. */
  readonly modo: ModoDescobertaRetomada;
  /** true somente após detail aplicado (SINGLE automático OU clique humano). */
  readonly campanhaAplicada: boolean;
}

/**
 * Gate determinístico da recuperação por hash: a UI só executa
 * GET /api/campaigns/persisted?hash=... quando este gate permite.
 */
export function recuperacaoPorHashPermitida(estado: EstadoRetomadaLogado): boolean {
  if (estado.modo === "MULTIPLE") return estado.campanhaAplicada;
  if (estado.modo === "EMPTY") return false;
  // SINGLE: conveniência de precisão da MESMA campanha (converge, nunca
  // escolhe outra). INDEFINIDO: descoberta ainda em voo — quando o modo for
  // decidido, o efeito re-executa (cleanup cancela o fetch anterior) e o
  // hash é re-ancorado na decisão da autoridade.
  return true;
}

/** Reset local completo (logout): nenhum estado operacional sobrevive. */
export const CHAVE_HASH_SESSAO = "ic_campanha_hash";
export const LIMPEZA_RETOMADA = {
  chaveHashSessao: CHAVE_HASH_SESSAO,
  hashSessao: "",
  campanha: null,
  modo: "INDEFINIDO",
  retomada: { status: "indefinida" },
} as const;
