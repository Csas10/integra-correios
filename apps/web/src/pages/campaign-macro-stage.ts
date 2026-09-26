/**
 * MÁQUINA DE ESTADOS PURA DA JORNADA OPERACIONAL (UX-FLOW-01A).
 *
 * Deriva a macroetapa visível a partir do ESTADO OPERACIONAL reconstruído
 * pelo servidor (sessão, base avaliada, aprovação congelada, campanha
 * persistida, lote) — nunca de cliques de navegação. As dez etapas
 * detalhadas permanecem como histórico/auditoria; os únicos destinos
 * navegáveis são as quatro macroetapas.
 *
 * Regras de derivação (contrato UX-FLOW-01):
 *   sem sessão .................................... → 1 IDENTIFICACAO
 *   sessão sem base e sem campanha ................ → 2 PREPARACAO
 *   mapeamento/decisões pendentes ................. → 2 PREPARACAO
 *   avaliação concluída (base + aptos) ............ → 3 REVISAO
 *   aprovação congelada sem persistência .......... → 3 REVISAO
 *   campanha APROVADA sem lote .................... → 4 OPERACAO (preparar lote)
 *   campanha LOTE_CRIADO com lote ................. → 4 OPERACAO (acompanhamento)
 *
 * AVANÇOS AUTOMÁTICOS: a função informa APENAS o destino da macroetapa
 * derivada. Nenhuma mutação relevante (aprovação, persistência, criação de
 * lote, execução) é encadeada automaticamente — cada uma permanece ação
 * humana explícita na sua macroetapa.
 */

export const MACROETAPAS = [
  { numero: 1, titulo: "Identificação e contexto", descricao: "Credencial individual validada no servidor; sessão curta e auditada." },
  { numero: 2, titulo: "Preparação", descricao: "Importação, mapeamento e classificação da base — nada persistido ainda." },
  { numero: 3, titulo: "Revisão e aprovação", descricao: "Revisão dos destinatários, prévia da comunicação e congelamento por hash." },
  { numero: 4, titulo: "Operação e acompanhamento", descricao: "Campanha persistida: preparo do lote HOLD e acompanhamento auditável." },
] as const;

export type MacroEtapaNumero = (typeof MACROETAPAS)[number]["numero"];
export type MacroEtapaId = "IDENTIFICACAO" | "PREPARACAO" | "REVISAO" | "OPERACAO";

export interface EstadoOperacionalUI {
  /** Sessão individual ativa reconstruída do servidor (GET /api/operator/me). */
  readonly sessaoAtiva: boolean;
  /** Base avaliada nesta sessão (análise + mapeamento + avaliação server-side). */
  readonly baseAvaliada: boolean;
  /** Decisões humanas obrigatórias ainda abertas (inconsistências pendentes). */
  readonly decisoesPendentes: boolean;
  /** Aprovação congelada vigente nesta sessão (hash SHA-256 do conteúdo). */
  readonly aprovacaoPresente: boolean;
  /** Campanha persistida reconstruída do PostgreSQL (ou null). */
  readonly campanha: {
    readonly estado: string;
    readonly loteId: string | null;
    readonly loteEstado: string | null;
  } | null;
}

export interface VisaoMacroEtapa {
  /** Macroetapa derivada do estado operacional — destino atual da UI. */
  readonly macro: MacroEtapaNumero;
  readonly macroId: MacroEtapaId;
  /** Rótulo do foco atual dentro da macroetapa (subtítulo operacional). */
  readonly foco: string;
  /**
   * Detalhamento de auditoria das dez etapas: visível como painel/histórico,
   * NUNCA como dez destinos obrigatórios de navegação.
   */
  readonly mostrarPainelAtividade: boolean;
  /** A revisão (6) e a prévia (7) são UMA tela única na macroetapa 3. */
  readonly revisaoUnificada: boolean;
}

/**
 * Macroetapa de destino a partir do estado operacional. Pura: mesma entrada,
 * mesma saída — testável sem DOM e sem rede.
 */
export function macroEtapaAtual(estado: EstadoOperacionalUI): VisaoMacroEtapa {
  if (!estado.sessaoAtiva) {
    return visao(1, "IDENTIFICACAO", "Credencial individual exigida", false);
  }
  const campanha = estado.campanha;
  if (campanha) {
    if (campanha.loteId !== null && campanha.loteEstado !== null) {
      return visao(4, "OPERACAO", "Acompanhamento do lote", true);
    }
    return visao(4, "OPERACAO", "Campanha pronta para preparar lote", true);
  }
  if (estado.aprovacaoPresente) {
    return visao(3, "REVISAO", "Aprovação congelada — persistir campanha", false);
  }
  if (estado.baseAvaliada) {
    if (estado.decisoesPendentes) {
      return visao(2, "PREPARACAO", "Decisões humanas pendentes", true);
    }
    return visao(3, "REVISAO", "Revisão e prévia unificadas", false);
  }
  return visao(2, "PREPARACAO", "Importar e mapear a base", true);
}

function visao(macro: MacroEtapaNumero, macroId: MacroEtapaId, foco: string, painel: boolean): VisaoMacroEtapa {
  return {
    macro,
    macroId,
    foco,
    mostrarPainelAtividade: painel,
    revisaoUnificada: macro === 3,
  };
}

// ---------------------------------------------------------------------------
// MAPEAMENTO DETERMINÍSTICO — regras homologadas do importador canônico
// (sugerirMapeamento: profissional_id ← MATRICULA|IDENTIFICACAO, nome ← NOME,
// email ← EMAIL; derivados ficam sem coluna). O mapeamento é determinístico
// quando TODOS os obrigatórios foram sugeridos, sem coluna duplicada.
// ---------------------------------------------------------------------------

/** Mapeamento determinístico: aplicar e seguir para a avaliação SEM tela manual. */
export function mapeamentoDeterministico(
  sugerido: Readonly<Record<string, number>>,
  obrigatorios: readonly string[],
): boolean {
  for (const campo of obrigatorios) {
    const coluna = sugerido[campo];
    if (typeof coluna !== "number" || coluna < 0) return false;
  }
  const colunasObrigatorias = obrigatorios
    .map((campo) => sugerido[campo])
    .filter((coluna): coluna is number => typeof coluna === "number");
  return new Set(colunasObrigatorias).size === colunasObrigatorias.length;
}

/**
 * Campos OBRIGATÓRIOS ainda exigindo decisão humana: sem coluna atribuída
 * ou com coluna duplicada por outro obrigatório. Usa exclusivamente a
 * sugestão das regras homologadas do importador — nenhuma nova heurística
 * de inferência é criada (UX-FLOW-01A regra 4).
 */
export function pendenciasMapeamento(
  mapeamento: Readonly<Record<string, number>>,
  obrigatorios: readonly string[],
): string[] {
  const colunas = new Map<number, string[]>();
  for (const campo of obrigatorios) {
    const coluna = mapeamento[campo];
    if (typeof coluna !== "number" || coluna < 0) continue;
    const lista = colunas.get(coluna) ?? [];
    lista.push(campo);
    colunas.set(coluna, lista);
  }
  return obrigatorios.filter((campo) => {
    const coluna = mapeamento[campo];
    if (typeof coluna !== "number" || coluna < 0) return true;
    return (colunas.get(coluna)?.length ?? 0) > 1;
  });
}

// ---------------------------------------------------------------------------
// AVANÇOS AUTOMÁTICOS DE MACROETAPA — destino derivado após cada evento da
// jornada. Nenhuma mutação relevante é encadeada: aprovar, persistir, criar
// lote e executar permanecem ações humanas explícitas.
// ---------------------------------------------------------------------------

export type EventoJornada =
  | { readonly tipo: "SESSAO_INICIADA" }
  | { readonly tipo: "ARQUIVO_ANALISADO"; readonly mapeamentoDeterministico: boolean }
  | { readonly tipo: "BASE_AVALIADA"; readonly decisoesPendentes: boolean }
  | { readonly tipo: "ULTIMA_DECISAO_RESOLVIDA"; readonly aptos: number }
  | { readonly tipo: "APROVACAO_CONGELADA" }
  | { readonly tipo: "CAMPANHA_PERSISTIDA"; readonly loteId: string | null }
  | { readonly tipo: "LOTE_CRIADO" };

export interface EntradaAposEvento {
  readonly sessaoAtiva: boolean;
  readonly baseAvaliada: boolean;
  readonly decisoesPendentes: boolean;
  readonly aprovacaoPresente: boolean;
  readonly campanha: EstadoOperacionalUI["campanha"];
}

/** Macroetapa de destino após um evento da jornada (derivação pura). */
export function destinoAposEvento(
  evento: EventoJornada,
  entrada: EntradaAposEvento,
): VisaoMacroEtapa {
  const estado: EstadoOperacionalUI = {
    sessaoAtiva: evento.tipo === "SESSAO_INICIADA" ? true : entrada.sessaoAtiva,
    baseAvaliada: evento.tipo === "BASE_AVALIADA" ? true : entrada.baseAvaliada,
    decisoesPendentes:
      evento.tipo === "ULTIMA_DECISAO_RESOLVIDA"
        ? false
        : evento.tipo === "BASE_AVALIADA"
          ? evento.decisoesPendentes
          : entrada.decisoesPendentes,
    aprovacaoPresente:
      evento.tipo === "APROVACAO_CONGELADA" ? true : entrada.aprovacaoPresente,
    campanha:
      evento.tipo === "CAMPANHA_PERSISTIDA"
        ? { estado: "APROVADA", loteId: evento.loteId, loteEstado: evento.loteId ? "HOLD" : null }
        : entrada.campanha,
  };
  return macroEtapaAtual(estado);
}
