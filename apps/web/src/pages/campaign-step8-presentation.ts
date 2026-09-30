/**
 * Decisão PURA de apresentação da etapa 08 do workspace de campanha.
 *
 * Separa as duas capacidades que antes estavam aninhadas em
 * `aprovacao && canPersistImport` + `base`:
 *   · Persistir campanha   → depende da APROVAÇÃO ATUAL em memória
 *                            (base + aprovacao + canPersistImport).
 *   · Criar lote           → depende da CAMPANHA PERSISTIDA reconstruída
 *                            do PostgreSQL (campanha + canCreateBatch +
 *                            ação EXECUTAR_LOTE), mesmo após
 *                            reload/logout/login (base=null, aprovacao=null).
 *
 * A visão NUNCA reconstrói dados operacionais a partir de base/aprovacao:
 * o payload de criação do lote usa exclusivamente `campanhaId` e
 * `hashAprovacao` da campanha persistida. O servidor permanece a autoridade
 * (operador proprietário, sessão, papel EXECUTOR, hash e invariantes).
 */

export interface EntradaEtapa8 {
  /** Base avaliada nesta sessão (transitória). */
  readonly basePresente: boolean;
  /** Aprovação congelada nesta sessão (transitória). */
  readonly aprovacaoPresente: boolean;
  /** Gate server-side de persistência (canPersistImport). */
  readonly canPersistImport: boolean;
  /** Gate server-side de criação de lote (canCreateBatch). */
  readonly canCreateBatch: boolean;
  /** Ação derivada do papel: EXECUTAR_LOTE presente em availableActions. */
  readonly acaoExecutarLote: boolean;
  /** Campanha persistida reconstruída do PostgreSQL (ou null). */
  readonly campanha: {
    readonly campanhaId: string;
    readonly hashAprovacao: string;
    readonly loteId: string | null;
  } | null;
}

export interface VisaoEtapa8 {
  /** Fluxo de aprovação da sessão (exige base transitória). */
  readonly mostrarFluxoAprovacao: boolean;
  /** CTA de persistência (exige aprovação atual + gate). */
  readonly mostrarCtaPersistencia: boolean;
  /** Painel próprio da campanha reconstruída (independe de base/aprovacao). */
  readonly mostrarPainelCampanhaReconstruida: boolean;
  /** CTA ativo de criação de lote (apenas lote ainda inexistente). */
  readonly mostrarCtaCriarLote: boolean;
  /** Estado do lote já existente — sem segunda ação ativa de criação. */
  readonly mostrarLoteExistente: boolean;
  /** Fallback “Ir para a importação” — SOMENTE sem base e sem campanha. */
  readonly mostrarFallbackImportacao: boolean;
  /** Acesso ao acompanhamento — independe de aprovacao/base. */
  readonly mostrarAcompanharCampanha: boolean;
  /**
   * Payload do lote SEMPRE derivado da campanha persistida
   * (campanhaId + hashAprovacao congelado) — nunca da aprovação transitória.
   */
  readonly payloadCriarLote: {
    readonly campanhaId: string;
    readonly conteudoHash: string;
  } | null;
}

export function visaoEtapa8(entrada: EntradaEtapa8): VisaoEtapa8 {
  const campanha = entrada.campanha;
  const mostrarPainelCampanha = campanha !== null;
  const mostrarCtaCriarLote =
    campanha !== null &&
    campanha.loteId === null &&
    entrada.canCreateBatch &&
    entrada.acaoExecutarLote;
  return {
    mostrarFluxoAprovacao: entrada.basePresente,
    mostrarCtaPersistencia: entrada.aprovacaoPresente && entrada.canPersistImport,
    mostrarPainelCampanhaReconstruida: mostrarPainelCampanha,
    mostrarCtaCriarLote,
    mostrarLoteExistente: campanha !== null && campanha.loteId !== null,
    mostrarFallbackImportacao: !entrada.basePresente && !mostrarPainelCampanha,
    mostrarAcompanharCampanha: mostrarPainelCampanha,
    payloadCriarLote:
      campanha !== null
        ? { campanhaId: campanha.campanhaId, conteudoHash: campanha.hashAprovacao }
        : null,
  };
}
