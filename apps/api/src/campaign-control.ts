/**
 * SLICE-03B — Plano de CONTROLE operacional da Campanha PF (NO SEND).
 *
 * Responsabilidades desta fatia (todas fail-closed, zero rede):
 *   A. Fingerprint canônico de destinatário — ÚNICA derivação usada pela
 *      persistência (campaign-persistence) e pela execução; server-side,
 *      nunca aceito do cliente, nunca logado (nenhuma PII em mensagens).
 *   B. Emissores SERVER-SIDE das provas exigidas pela fundação 03A
 *      (ProvasAutorizacaoExecucao): prova de destinatário (derivada do item
 *      persistido do operador) e prova de autorização humana (vínculo
 *      operator_id/campanha/lote/item/idempotência/ação + nonce, detecção de
 *      replay por re-emissão com referência auditada).
 *   C. Estoque READ-ONLY (lerEstoqueOperacionalCampanha): contagens por
 *      estado da outbox da campanha — nenhuma mutação, nenhuma PII.
 *   D. Política de PREPARAÇÃO separada da execução: canPrepareBatch
 *      (PF_CAMPAIGN_PREPARE_ENABLED, default false) — preparar NUNCA liga o
 *      Gmail e NUNCA arma envio; canExecute/realSendEnabled permanecem
 *      autoridade exclusiva de executeAttemptCampanha (03A, intocado).
 *   E. Mutações mínimas transacionais: preparar lote (HOLD→PREPARADO) e
 *      registrar autorização humana (evento append-only + referência na
 *      outbox HOLD/PREPARADO do lote do operador).
 *
 * Regras invioláveis preservadas:
 *   · operator_id SEMPRE da sessão (nenhum parâmetro de rota confere escopo);
 *   · recurso alheio/inexistente = null (rota responde 404 sanitizado);
 *   · nenhuma mutação antes da avaliação completa de política + estado;
 *   · o claim de execução continua atomicamente acoplado a
 *     lote='ATIVO' AND item='PREPARADO' (03A) — nada aqui pode concedê-lo;
 *   · nenhuma import do piloto (pilot.ts) e nenhum provider de rede: o único
 *     provider válido é o injetado pelo teste em executeAttemptCampanha.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { CampanhaPool, CampanhaSqlExecutor } from "./campaign-persistence.js";

export type { CampanhaPool, CampanhaSqlExecutor } from "./campaign-persistence.js";
import type { PfUpdateCampaignPolicy } from "./campaigns.js";
import { chaveIdempotenciaExecucao } from "./campaign-execution.js";

export class CampaignControlError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CampaignControlError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// A. FINGERPRINT CANÔNICO — única derivação de destinatario_fingerprint
// ---------------------------------------------------------------------------

/**
 * SEMÂNTICA HOMOLOGADA PRESERVADA EXATAMENTE (SLICE-03B): SHA-256 dos bytes
 * do e-mail JÁ NORMALIZADO pela avaliação server-side. Este helper:
 *   · NÃO normaliza nada — caixa e espaços são preservados byte a byte
 *     (quem normaliza é o importador/avaliador; alteração silenciosa aqui
 *     mudaria fingerprints persistidos);
 *   · é determinístico: entradas iguais ⇒ fingerprints iguais (duplicidades
 *     de destinatário produzem o MESMO fingerprint — comportamento atual);
 *   · rejeita entrada vazia/não-string com erro sanitizado (a mensagem
 *     NUNCA ecoa o valor avaliado — nenhuma PII em logs/eventos/erros);
 *   · é a ÚNICA derivação usada pela persistência (campaign-persistence) e
 *     pelas provas/verificadores deste módulo (paridade por construção).
 */
export function fingerprintDestinatarioCampanha(
  emailNormalizado: string,
): string {
  if (typeof emailNormalizado !== "string" || emailNormalizado === "") {
    throw new CampaignControlError(
      "CAMPAIGN_FINGERPRINT_INVALID",
      "E-mail normalizado ausente ou inválido para derivação do fingerprint.",
    );
  }
  return createHash("sha256").update(emailNormalizado).digest("hex");
}

// ---------------------------------------------------------------------------
// B. PROVAS SERVER-SIDE (emissores do contrato ProvasAutorizacaoExecucao)
// ---------------------------------------------------------------------------

/** Ação única autorizável nesta fatia (escopo mínimo da prova humana). */
export const ACAO_AUTORIZADA_EXECUCAO = "EXECUTAR_ITEM_CAMPANHA" as const;

type Environment = Readonly<Record<string, string | undefined>>;

export interface ConfiguracaoChaveProvaCampanha {
  /** true somente com PF_CAMPAIGN_PROOF_KEY_BASE64 válida (base64, >= 32 bytes). */
  readonly proofKeyReady: boolean;
  /** Chave decodificada — NUNCA logada, persistida ou ecoada em erro/resposta. */
  readonly chave: Buffer | null;
}

/**
 * SLICE-03C.1 — Chave dedicada das provas (fail-closed). Substitui a chave
 * literal anterior (descontinuada): sem PF_CAMPAIGN_PROOF_KEY_BASE64 válida as
 * emissões/verificações FALHAM (proofKeyReady=false) — nenhuma prova é
 * emitida ou aceita. A chave NÃO reutiliza OPERATOR_TOKEN nem
 * DOCUMENT_FINGERPRINT_KEY_BASE64 e nunca aparece em log, erro, auditoria
 * ou resposta. Nenhuma variável é criada aqui: a configuração é lida do
 * ambiente server-side (Vercel permanece intocada neste gate).
 */
export function lerConfiguracaoChaveProvaCampanha(
  env: Environment = process.env,
): ConfiguracaoChaveProvaCampanha {
  const bruta = env.PF_CAMPAIGN_PROOF_KEY_BASE64?.trim() ?? "";
  if (bruta === "") return { proofKeyReady: false, chave: null };
  try {
    const decodificada = Buffer.from(bruta, "base64");
    if (decodificada.length < 32) return { proofKeyReady: false, chave: null };
    return { proofKeyReady: true, chave: decodificada };
  } catch {
    return { proofKeyReady: false, chave: null };
  }
}

export interface ConfiguracaoCanarioCampanha {
  /** true somente com fingerprint canônico de 64 hex configurado server-side. */
  readonly canaryRecipientConfigured: boolean;
  /** Fingerprint configurado — NUNCA logado, persistido ou ecoado. */
  readonly fingerprint: string | null;
}

/**
 * SLICE-03C.1 — Destinatário canário (fail-closed, server-side). A seleção
 * NUNCA é automática ("primeiro item") e NUNCA vem do cliente: exige
 * PF_CAMPAIGN_CANARY_RECIPIENT_FINGERPRINT com EXATAMENTE o formato canônico
 * (64 hex minúsculos — o mesmo derivado por fingerprintDestinatarioCampanha).
 * Ausente/inválido mantém a seleção bloqueada. O valor nunca é impresso em
 * log, erro, auditoria ou resposta. Nenhuma variável Vercel é criada aqui.
 */
export function lerConfiguracaoCanarioCampanha(
  env: Environment = process.env,
): ConfiguracaoCanarioCampanha {
  const bruta = env.PF_CAMPAIGN_CANARY_RECIPIENT_FINGERPRINT?.trim() ?? "";
  if (/^[0-9a-f]{64}$/.test(bruta)) {
    return { canaryRecipientConfigured: true, fingerprint: bruta };
  }
  return { canaryRecipientConfigured: false, fingerprint: null };
}

function exigirChaveProva(chave: Buffer | undefined): Buffer {
  if (chave && chave.length >= 32) return chave;
  const configuracao = lerConfiguracaoChaveProvaCampanha();
  if (!configuracao.proofKeyReady || !configuracao.chave) {
    throw new CampaignControlError(
      "CAMPAIGN_PROOF_KEY_UNAVAILABLE",
      "Chave de provas indisponível — emissão e verificação permanecem bloqueadas.",
    );
  }
  return configuracao.chave;
}

/**
 * SLICE-03C.1 — Resolve a chave de prova com prioridade para a chave INJETADA
 * (somente testes de domínio); ausente/inválida, lê a configuração server-side
 * (fail-closed). O valor nunca é logado, persistido ou ecoado.
 */
function resolverChaveProva(contexto: { readonly chaveProva?: Buffer } = {}): {
  readonly proofKeyReady: boolean;
  readonly chave: Buffer | null;
} {
  if (contexto.chaveProva && contexto.chaveProva.length >= 32) {
    return { proofKeyReady: true, chave: contexto.chaveProva };
  }
  return lerConfiguracaoChaveProvaCampanha();
}

export type TipoProvaCampanha = "PROVA_DESTINATARIO_CAMPANHA_V1" | "PROVA_AUTORIZACAO_HUMANA_CAMPANHA_V1";

/**
 * Canonicalização determinística do vínculo da prova (ordem fixa,
 * separador \n; fingerprints/UUIDs/hex são livres de \n por construção).
 */
export function bindingProvaCampanha(campos: readonly string[]): string {
  return campos.join("\n");
}

function hmacProva(campos: readonly string[], chaveProva?: Buffer): string {
  return createHmac("sha256", exigirChaveProva(chaveProva))
    .update(bindingProvaCampanha(campos))
    .digest("hex");
}

/**
 * Prova de DESTINATÁRIO (server-side): HMAC sobre a derivação canônica do
 * destinatário do item persistido do próprio operador (campanha → lote →
 * item). Nada disso é aceito do cliente: a rota deriva TUDO do banco.
 */
export function emitirProvaDestinatarioCampanha(entrada: {
  readonly campanhaId: string;
  readonly loteCampanhaId: string;
  readonly itemId: string;
  readonly fingerprintDestinatario: string;
  /** Chave injetada (testes); ausente → configuração server-side fail-closed. */
  readonly chaveProva?: Buffer;
}): { readonly tipo: TipoProvaCampanha; readonly valor: string } {
  return {
    tipo: "PROVA_DESTINATARIO_CAMPANHA_V1",
    valor: hmacProva(
      [
        "PROVA_DESTINATARIO_CAMPANHA_V1",
        entrada.campanhaId,
        entrada.loteCampanhaId,
        entrada.itemId,
        entrada.fingerprintDestinatario,
      ],
      entrada.chaveProva,
    ),
  };
}

export interface VerificacaoProvaDestinatarioCampanha {
  readonly verificada: boolean;
  /** Motivo estável e sanitizado (nenhuma PII, nenhum valor derivado). */
  readonly motivo: string | null;
}

/**
 * Verificador SERVER-SIDE da prova de destinatário (SLICE-03B): deriva o
 * fingerprint canônico do snapshot CONGELADO da campanha pela ordem do item
 * (ordem = posição no snapshot) e confere com o fingerprint PERSISTIDO na
 * linha. Derivação e conferência acontecem exclusivamente no servidor, com
 * dados do item persistido do operador — nada é aceito do cliente.
 */
export async function verificarProvaDestinatarioCampanha(
  executor: CampanhaSqlExecutor,
  ids: {
    readonly campanhaId: string;
    readonly loteCampanhaId: string;
    readonly itemId: string;
  },
): Promise<VerificacaoProvaDestinatarioCampanha> {
  const linhas = await executor.query(
    `SELECT i.ordem, i.destinatario_fingerprint, s.snapshot_registros
       FROM outbox_campanha i
       JOIN lote_campanha l ON l.id = i.lote_campanha_id
       JOIN campanha_persistida s ON s.id = l.campanha_id
      WHERE i.id = $1 AND l.id = $2 AND s.id = $3`,
    [ids.itemId, ids.loteCampanhaId, ids.campanhaId],
  );
  const linha = linhas.rows[0] as
    | {
        ordem: number;
        destinatario_fingerprint: string;
        snapshot_registros: { registros?: readonly { email_normalizado?: string }[] };
      }
    | undefined;
  if (!linha) {
    return { verificada: false, motivo: "ITEM_INEXISTENTE" };
  }
  const registros = linha.snapshot_registros.registros ?? [];
  const registro = registros[Number(linha.ordem) - 1];
  const email = registro?.email_normalizado;
  if (typeof email !== "string" || email === "") {
    return { verificada: false, motivo: "SNAPSHOT_INCOMPATIVEL" };
  }
  const derivado = fingerprintDestinatarioCampanha(email);
  const persistido = String(linha.destinatario_fingerprint);
  if (derivado === persistido) {
    return { verificada: true, motivo: null };
  }
  return { verificada: false, motivo: "FINGERPRINT_DIVERGENTE" };
}

export interface ProvaAutorizacaoHumanaCampanha {
  readonly tipo: TipoProvaCampanha;
  /** HMAC do vínculo completo —Nunca contém e-mail/PII (só UUIDs/hex). */
  readonly valor: string;
  /** Referência auditada da emissão (tipo CAMPANHA_EXECUCAO_AUTORIZADA). */
  readonly referencia: string;
  readonly emitidaEm: string;
}

/**
 * Prova de AUTORIZAÇÃO HUMANA (server-side): HMAC sobre, NO MÍNIMO,
 * operator_id (sessão), campanha, lote, item, chave idempotente revalidada,
 * ação autorizada e nonce (antirreplay, unicidade por emissão). O HMAC é
 * determinístico no vínculo — a detecção de replay é estrutural: uma nova
 * emissão exige novo evento auditado (referência nova); uma prova
 * apresentada sem emissão vigente é rejeitada pelo verificador.
 */
export function emitirProvaAutorizacaoHumanaCampanha(entrada: {
  readonly operatorId: string;
  readonly campanhaId: string;
  readonly loteCampanhaId: string;
  readonly itemId: string;
  /** Chave idempotente da execução (revalidada pelo chamador/03A). */
  readonly chaveIdempotencia: string;
  readonly acaoAutorizada: string;
  readonly nonce: string;
  /** Chave injetada (testes); ausente → configuração server-side fail-closed. */
  readonly chaveProva?: Buffer;
}): ProvaAutorizacaoHumanaCampanha {
  const agora = new Date().toISOString();
  return {
    tipo: "PROVA_AUTORIZACAO_HUMANA_CAMPANHA_V1",
    valor: hmacProva(
      [
        "PROVA_AUTORIZACAO_HUMANA_CAMPANHA_V1",
        entrada.operatorId,
        entrada.campanhaId,
        entrada.loteCampanhaId,
        entrada.itemId,
        entrada.chaveIdempotencia,
        entrada.acaoAutorizada,
        entrada.nonce,
      ],
      entrada.chaveProva,
    ),
    referencia: entrada.nonce,
    emitidaEm: agora,
  };
}

export interface VerificacaoProvaAutorizacaoHumana {
  readonly verificada: boolean;
  /** Motivo estável e sanitizado (sem conteúdo da prova apresentada). */
  readonly motivo: string | null;
}

const FORMATO_PROVA_HUMANA = /^[0-9a-f]{64}$/;
const FORMATO_REFERENCIA = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Verificador da prova humana: formato → vínculo exato (operator/campanha/
 * lote/item/chave/ação) → existência da emissão auditada vigente
 * (antirreplay estrutural: a prova só vale com evento posterior à última
 * mutação do item e anterior ao settlement; qualquer divergência é
 * indistinguível de replay — motivo único REPRODUZIDA).
 */
export async function verificarProvaAutorizacaoHumanaCampanha(
  pool: CampanhaSqlExecutor,
  esperado: {
    readonly operatorId: string;
    readonly campanhaId: string;
    readonly loteCampanhaId: string;
    readonly itemId: string;
    readonly chaveIdempotencia: string;
  },
  apresentada: { readonly valor: string; readonly referencia: string } | null | undefined,
  contexto: { readonly chaveProva?: Buffer } = {},
): Promise<VerificacaoProvaAutorizacaoHumana> {
  if (
    !apresentada ||
    typeof apresentada.valor !== "string" ||
    !FORMATO_PROVA_HUMANA.test(apresentada.valor) ||
    typeof apresentada.referencia !== "string" ||
    !FORMATO_REFERENCIA.test(apresentada.referencia)
  ) {
    return { verificada: false, motivo: "FORMATO_INVALIDO" };
  }
  const esperada = hmacProva(
    [
      "PROVA_AUTORIZACAO_HUMANA_CAMPANHA_V1",
      esperado.operatorId,
      esperado.campanhaId,
      esperado.loteCampanhaId,
      esperado.itemId,
      esperado.chaveIdempotencia,
      ACAO_AUTORIZADA_EXECUCAO,
      apresentada.referencia,
    ],
    contexto.chaveProva,
  );
  // Comparação TIMING-SAFE (defesa contra canal lateral na conferência do HMAC).
  const a = Buffer.from(esperada);
  const b = Buffer.from(apresentada.valor);
  const vinculoOk = a.length === b.length && timingSafeEqual(a, b);
  if (!vinculoOk) {
    // Vínculo divergente E prova sem emissão vigente são o mesmo motivo —
    // nenhum detalhe do desvio é revelado (defesa em profundidade).
    return { verificada: false, motivo: "VINCULO_INCOMPATIVEL" };
  }
  // Antirreplay ESTRUTURAL: a referência precisa ser um evento de
  // AUTORIZAÇÃO real deste lote, carregando a ação autorizada. O vínculo do
  // item e da chave idempotente já está no HMAC recomputável (determinístico
  // sobre dados derivados do banco + a própria referência).
  const vigente = await pool.query(
    `SELECT count(*)::int AS total FROM evento_auditoria
      WHERE agregado_tipo = 'CAMPANHA_EXECUCAO'
        AND tipo = $1
        AND agregado_id = $2
        AND id = $3::uuid
        AND metadados->>'acao' = $4`,
    [
      CODIGO_EVENTO_AUTORIZACAO,
      esperado.loteCampanhaId,
      apresentada.referencia,
      ACAO_AUTORIZADA_EXECUCAO,
    ],
  );
  if ((vigente.rows[0] as { total: number } | undefined)?.total !== 1) {
    return { verificada: false, motivo: "REPRODUZIDA" };
  }
  // SLICE-03C.1 — a AUTORIDADE de ordenação é evento_auditoria.sequencia
  // (IDENTITY durável, 0001): o settlement só invalida a prova quando a sua
  // sequência é POSTERIOR à do evento de autorização. Timestamps permanecem
  // como evidência — nunca como autoridade única (imutáveis sob relógio).
  const settle = await pool.query(
    `SELECT count(*)::int AS total FROM evento_auditoria
      WHERE agregado_tipo = 'CAMPANHA_EXECUCAO'
        AND agregado_id = $1
        AND tipo IN ('EXEC_RECEIPT', 'EXEC_SETTLEMENT')
        AND sequencia > (SELECT sequencia FROM evento_auditoria WHERE id = $2::uuid)`,
    [esperado.itemId, apresentada.referencia],
  );
  if ((settle.rows[0] as { total: number } | undefined)?.total !== 0) {
    return { verificada: false, motivo: "REPRODUZIDA" };
  }
  return { verificada: true, motivo: null };
}

// ---------------------------------------------------------------------------
// C. ESTOQUE OPERACIONAL READ-ONLY (contagens; nenhuma mutação; sem PII)
// ---------------------------------------------------------------------------

export interface EstoqueOperacionalCampanha {
  readonly campanhaId: string;
  readonly loteCampanhaId: string;
  readonly loteCodigo: string;
  readonly loteEstado: string;
  readonly totalItens: number;
  /** Contagem de itens da outbox da campanha por estado (camada de exibição). */
  readonly contagemPorEstado: Readonly<Record<string, number>>;
  /** Autorização humana vigente: derivada do evento auditado (nunca do cliente). */
  readonly autorizacaoHumana: {
    readonly concedida: boolean;
    readonly referencia: string | null;
  };
  /** SLICE-03C.1 — campos não sensíveis do plano de ativação (sem segredo). */
  readonly proofKeyReady: boolean;
  readonly canaryRecipientConfigured: boolean;
  /** true quando o evento CAMPANHA_CANARIO_SELECIONADO já existe no lote. */
  readonly canarySelected: boolean;
  readonly canaryReferencePresent: boolean;
  /** Sempre false neste slice: nenhum provider runtime é montado. */
  readonly providerReady: false;
}

/**
 * Leitura read-only do estoque do lote ÚNICO da campanha (ownership do
 * operador resolvido ANTES, via campanha_persistida.operator_id). Retorno
 * null = campanha inexistente ou alheia (indistinguíveis — 404 sanitizado).
 */
export async function lerEstoqueOperacionalCampanha(
  pool: CampanhaSqlExecutor,
  comando: { readonly operatorId: string; readonly campanhaId: string },
  contexto: { readonly chaveProva?: Buffer } = {},
): Promise<EstoqueOperacionalCampanha | null> {
  const campanha = await pool.query(
    `SELECT c.id FROM campanha_persistida c
      WHERE c.id = $1 AND c.operator_id = $2`,
    [comando.campanhaId, comando.operatorId],
  );
  if (!campanha.rows[0]) return null;
  const lote = await pool.query(
    `SELECT l.id, l.codigo, l.estado, l.total_itens
       FROM lote_campanha l
      WHERE l.campanha_id = $1
      LIMIT 1`,
    [comando.campanhaId],
  );
  const linha = lote.rows[0] as
    | { id: string; codigo: string; estado: string; total_itens: number }
    | undefined;
  if (!linha) return null;
  const contagem = await pool.query(
    `SELECT estado, count(*)::int AS total FROM outbox_campanha
      WHERE lote_campanha_id = $1 GROUP BY estado`,
    [linha.id],
  );
  const contagemPorEstado: Record<string, number> = {};
  for (const linhaContagem of contagem.rows as { estado: string; total: number }[]) {
    contagemPorEstado[linhaContagem.estado] = Number(linhaContagem.total);
  }
  const autorizacao = await pool.query(
    `SELECT id FROM evento_auditoria
      WHERE agregado_tipo = 'CAMPANHA_EXECUCAO'
        AND tipo = $1
        AND agregado_id = $2
      ORDER BY sequencia DESC LIMIT 1`,
    [CODIGO_EVENTO_AUTORIZACAO, linha.id],
  );
  const referenciaAutorizacao =
    (autorizacao.rows[0] as { id: string } | undefined)?.id ?? null;
  const canario = await pool.query(
    `SELECT id FROM evento_auditoria
      WHERE agregado_tipo = 'CAMPANHA_EXECUCAO'
        AND tipo = $1
        AND agregado_id = $2
      ORDER BY sequencia DESC LIMIT 1`,
    [CODIGO_EVENTO_CANARIO, linha.id],
  );
  const canarioId = (canario.rows[0] as { id: string } | undefined)?.id ?? null;
  return {
    campanhaId: comando.campanhaId,
    loteCampanhaId: linha.id,
    loteCodigo: linha.codigo,
    loteEstado: linha.estado,
    totalItens: Number(linha.total_itens),
    contagemPorEstado,
    autorizacaoHumana: {
      concedida: referenciaAutorizacao !== null,
      referencia: referenciaAutorizacao,
    },
    proofKeyReady: resolverChaveProva(contexto).proofKeyReady,
    canaryRecipientConfigured: lerConfiguracaoCanarioCampanha().canaryRecipientConfigured,
    canarySelected: canarioId !== null,
    canaryReferencePresent: canarioId !== null,
    providerReady: false,
  };
}

// ---------------------------------------------------------------------------
// D. POLÍTICA DE PREPARAÇÃO (fail-closed) + ELEGIBILIDADE POR AÇÃO
// ---------------------------------------------------------------------------

/** Código de lote reservado à preparação via rota de controle (03B). */
export const CODIGO_LOTE_PREPARADO_POR_ROTA = "CAMPAIGN_PREPARE_ROTA_V1" as const;

/** Evento append-only que materializa a autorização humana vigente. */
export const CODIGO_EVENTO_AUTORIZACAO = "CAMPANHA_EXECUCAO_AUTORIZADA" as const;

/** Evento append-only do canário controlado (metadata sanitizada, sem PII). */
export const CODIGO_EVENTO_CANARIO = "CAMPANHA_CANARIO_SELECIONADO" as const;

/** Evento append-only da ativação explícita do lote (PREPARADO → ATIVO). */
export const CODIGO_EVENTO_ATIVACAO = "CAMPANHA_LOTE_ATIVADO" as const;

export type AcaoOperacaoCampanha =
  | "PREPARAR_LOTE"
  | "AUTORIZAR_EXECUCAO"
  | "ATIVAR_LOTE"
  | "EXECUTAR_ITEM";

export type MotivoBloqueioAcaoOperacao =
  | "CAMPAIGN_PREPARE_DISABLED"
  | "CAMPAIGN_EXECUTE_DISABLED"
  | "REAL_SEND_DISABLED"
  | "LOTE_NAO_PREPARADO"
  | "LOTE_NAO_ATIVO"
  | "AUTORIZACAO_HUMANA_AUSENTE"
  | "AUTORIZACAO_HUMANA_VIGENTE"
  | "LOTE_SEM_ITENS"
  | "PROOF_KEY_UNAVAILABLE"
  | "CANARY_RECIPIENT_NOT_CONFIGURED"
  | "CANARY_RECIPIENT_NOT_FOUND"
  | "CANARY_RECIPIENT_AMBIGUOUS"
  | "CANARIO_JA_SELECIONADO"
  | "REAL_SEND_MUST_BE_DISABLED_FOR_ACTIVATION";

export interface EntradaAcaoOperacaoCampanha {
  readonly acao: AcaoOperacaoCampanha;
  readonly politica: PfUpdateCampaignPolicy;
  readonly loteEstado: string;
  readonly totalItens: number;
  readonly autorizacaoHumanaConcedida: boolean;
  /** SLICE-03C.1 — insumos de ativação (padrões: bloqueio sanitizado). */
  readonly proofKeyReady?: boolean;
  readonly canaryRecipientConfigured?: boolean;
  readonly canarySelecionado?: boolean;
  readonly realSendEnabled?: boolean;
}

export interface AvaliacaoAcaoOperacaoCampanha {
  readonly permitida: boolean;
  readonly bloqueios: readonly MotivoBloqueioAcaoOperacao[];
}

/**
 * Elegibilidade STRUCTURAL por ação (sem provider, sem rede):
 *   PREPARAR_LOTE      → canPrepareBatch ∧ lote HOLD ∧ totalItens > 0
 *                        (preparar NUNCA liga Gmail: toca apenas
 *                        lote_campanha/outbox_campanha da campanha).
 *   AUTORIZAR_EXECUCAO → canExecute ∧ lote PREPARADO ∧ sem autorização
 *                        vigente (evento append-only é idempotente).
 *   EXECUTAR_ITEM      → canExecute ∧ realSendEnabled ∧ lote ATIVO ∧
 *                        autorização vigente (estrutural; os gates por item
 *                        permanecem em executeAttemptCampanha — 03A).
 */
export function avaliarAcaoOperacaoCampanha(
  entrada: EntradaAcaoOperacaoCampanha,
): AvaliacaoAcaoOperacaoCampanha {
  const bloqueios: MotivoBloqueioAcaoOperacao[] = [];
  if (entrada.acao === "PREPARAR_LOTE") {
    if (!entrada.politica.canPrepareBatch) bloqueios.push("CAMPAIGN_PREPARE_DISABLED");
    if (entrada.loteEstado !== "HOLD") bloqueios.push("LOTE_NAO_PREPARADO");
    if (entrada.totalItens <= 0) bloqueios.push("LOTE_SEM_ITENS");
    return { permitida: bloqueios.length === 0, bloqueios };
  }
  if (entrada.acao === "AUTORIZAR_EXECUCAO") {
    if (!entrada.politica.canExecute) bloqueios.push("CAMPAIGN_EXECUTE_DISABLED");
    if (entrada.loteEstado !== "PREPARADO") bloqueios.push("LOTE_NAO_PREPARADO");
    if (entrada.autorizacaoHumanaConcedida) bloqueios.push("AUTORIZACAO_HUMANA_VIGENTE");
    return { permitida: bloqueios.length === 0, bloqueios };
  }
  if (entrada.acao === "ATIVAR_LOTE") {
    // SLICE-03C.1 — ativação fail-closed: canExecute=true e realSendEnabled
    // deve permanecer FALSE (o envio real só é armado no 03C.2, com nova
    // autorização do owner). Prova exige chave; canário exige configuração
    // server-side e não pode ter sido escolhido antes.
    if (!entrada.politica.canExecute) bloqueios.push("CAMPAIGN_EXECUTE_DISABLED");
    if (entrada.realSendEnabled !== false) bloqueios.push("REAL_SEND_MUST_BE_DISABLED_FOR_ACTIVATION");
    if (entrada.proofKeyReady !== true) bloqueios.push("PROOF_KEY_UNAVAILABLE");
    if (entrada.canaryRecipientConfigured !== true) bloqueios.push("CANARY_RECIPIENT_NOT_CONFIGURED");
    if (entrada.loteEstado !== "PREPARADO") bloqueios.push("LOTE_NAO_PREPARADO");
    if (!entrada.autorizacaoHumanaConcedida) bloqueios.push("AUTORIZACAO_HUMANA_AUSENTE");
    if (entrada.canarySelecionado === true) bloqueios.push("CANARIO_JA_SELECIONADO");
    return { permitida: bloqueios.length === 0, bloqueios };
  }
  if (!entrada.politica.canExecute) bloqueios.push("CAMPAIGN_EXECUTE_DISABLED");
  if (!entrada.politica.realSendEnabled) bloqueios.push("REAL_SEND_DISABLED");
  if (entrada.loteEstado !== "ATIVO") bloqueios.push("LOTE_NAO_ATIVO");
  if (!entrada.autorizacaoHumanaConcedida) bloqueios.push("AUTORIZACAO_HUMANA_AUSENTE");
  return { permitida: bloqueios.length === 0, bloqueios };
}

// ---------------------------------------------------------------------------
// E. MUTAÇÕES MÍNIMAS — preparar lote e autorizar execução (transacionais)
// ---------------------------------------------------------------------------

function hashEventoControle(id: string, ocorreuEm: string): string {
  return createHmac("sha256", "audit-chain").update(id).update(ocorreuEm).digest("hex");
}

async function executarTransacao(
  pool: CampanhaPool,
  trabalho: (executor: CampanhaSqlExecutor) => Promise<void>,
): Promise<void> {
  const transaction = await pool.connect();
  try {
    await transaction.query("BEGIN");
    await trabalho(transaction);
    await transaction.query("COMMIT");
  } catch (error) {
    try {
      await transaction.query("ROLLBACK");
    } catch {
      // Preserva a causa original; a conexão é liberada no finally.
    }
    throw error;
  } finally {
    transaction.release();
  }
}

export interface ResultadoProvasServerSideCampanha {
  readonly provas: {
    readonly recipientProofVerified: boolean;
    readonly humanAuthorizationVerified: boolean;
  };
  /** Motivo agregado sanitizado quando alguma prova falha (sem PII/HMAC). */
  readonly motivo: string | null;
}

/**
 * COMPOSITOR das provas server-side (SLICE-03B): usado pela rota de
 * execução. Ownership primeiro (campanha+lote+item do operador — alheio/
 * inexistente ⇒ null ⇒ 404 sanitizado); depois (1) prova de destinatário
 * derivada e conferida contra o item persistido e (2) prova humana emitida
 * sobre a emissão auditada VIGENTE (nonce = referência do evento) e
 * verificada com detecção de replay. Nada é aceito do cliente.
 */
export async function emitirProvasServerSideCampanha(
  pool: CampanhaPool,
  ids: {
    readonly operatorId: string;
    readonly campanhaId: string;
    readonly loteCampanhaId: string;
    readonly itemId: string;
  },
  contexto: { readonly chaveProva?: Buffer } = {},
): Promise<ResultadoProvasServerSideCampanha | null> {
  const ownership = await pool.query(
    `SELECT 1 AS ok
       FROM outbox_campanha i
       JOIN lote_campanha l ON l.id = i.lote_campanha_id
       JOIN campanha_persistida c ON c.id = l.campanha_id
      WHERE i.id = $1 AND l.id = $2 AND c.id = $3 AND c.operator_id = $4`,
    [ids.itemId, ids.loteCampanhaId, ids.campanhaId, ids.operatorId],
  );
  if (!ownership.rows[0]) return null;
  const provaDestinatario = await verificarProvaDestinatarioCampanha(pool, ids);
  const chaveLinha = await pool.query(
    `SELECT i.destinatario_fingerprint, c.hash_aprovacao
       FROM outbox_campanha i
       JOIN lote_campanha l ON l.id = i.lote_campanha_id
       JOIN campanha_persistida c ON c.id = l.campanha_id
      WHERE i.id = $1 AND l.id = $2 AND c.id = $3 AND c.operator_id = $4`,
    [ids.itemId, ids.loteCampanhaId, ids.campanhaId, ids.operatorId],
  );
  const chaveDados = chaveLinha.rows[0] as
    | { destinatario_fingerprint: string; hash_aprovacao: string }
    | undefined;
  if (!chaveDados) return null;
  const chaveIdempotencia = chaveIdempotenciaExecucao({
    campanhaId: ids.campanhaId,
    loteCampanhaId: ids.loteCampanhaId,
    itemId: ids.itemId,
    destinatarioFingerprint: chaveDados.destinatario_fingerprint,
    hashAprovacao: chaveDados.hash_aprovacao,
  });
  // SLICE-03C.1 — chave DEDICADA das provas (injetada por teste ou lida da
  // configuração server-side). Indisponível ⇒ emissão/verificação falham.
  const { chave: chaveProva } = resolverChaveProva(contexto);
  const emissao = await pool.query(
    `SELECT id, sequencia FROM evento_auditoria
      WHERE agregado_tipo = 'CAMPANHA_EXECUCAO'
        AND tipo = $1
        AND agregado_id = $2
      ORDER BY sequencia DESC LIMIT 1`,
    [CODIGO_EVENTO_AUTORIZACAO, ids.loteCampanhaId],
  );
  const linhaEmissao = emissao.rows[0] as
    | { id: string; sequencia: string | number }
    | undefined;
  const referencia = linhaEmissao?.id ?? null;
  if (!referencia) {
    // Fail-closed 03C.1: sem chave de prova nenhuma verificação pode ser
    // concluída — o motivo declara a causa raiz sanitizada.
    const { proofKeyReady } = resolverChaveProva(contexto);
    return {
      provas: {
        recipientProofVerified: provaDestinatario.verificada,
        humanAuthorizationVerified: false,
      },
      motivo: !proofKeyReady
        ? "PROOF_KEY_UNAVAILABLE"
        : (provaDestinatario.motivo ?? "AUTORIZACAO_HUMANA_AUSENTE"),
    };
  }
  const provaHumana = emitirProvaAutorizacaoHumanaCampanha({
    operatorId: ids.operatorId,
    campanhaId: ids.campanhaId,
    loteCampanhaId: ids.loteCampanhaId,
    itemId: ids.itemId,
    chaveIdempotencia,
    acaoAutorizada: ACAO_AUTORIZADA_EXECUCAO,
    nonce: referencia,
    ...(chaveProva ? { chaveProva } : {}),
  });
  const verificacao = await verificarProvaAutorizacaoHumanaCampanha(
    pool,
    {
      operatorId: ids.operatorId,
      campanhaId: ids.campanhaId,
      loteCampanhaId: ids.loteCampanhaId,
      itemId: ids.itemId,
      chaveIdempotencia,
    },
    { valor: provaHumana.valor, referencia },
    { ...(chaveProva ? { chaveProva } : {}) },
  );
  return {
    provas: {
      recipientProofVerified: provaDestinatario.verificada,
      humanAuthorizationVerified: verificacao.verificada,
    },
    motivo: provaDestinatario.verificada
      ? (verificacao.motivo ?? null)
      : (provaDestinatario.motivo ?? "PROVA_DESTINATARIO_AUSENTE"),
  };
}

export type ResultadoPrepararLoteCampanha =
  | {
      readonly resultado: "PREPARADO";
      readonly campanhaId: string;
      readonly loteCampanhaId: string;
      readonly loteCodigo: string;
      readonly totalItens: number;
    }
  | {
      readonly resultado: "EXISTENTE";
      readonly campanhaId: string;
      readonly loteCampanhaId: string;
      readonly loteCodigo: string;
      readonly totalItens: number;
    };

/**
 * PREPARAÇÃO do lote (HOLD → PREPARADO): marca a outbox PRÓPRIA da campanha
 * como PREPARADO (ainda NÃO capturável — o claim da 03A exige lote ATIVO) e
 * audita CAMPANHA_EXECUCAO/CAMPANHA_LOTE_PREPARADO. NÃO cria lote_comunicacao,
 * NÃO cria comunicacao/outbox_email, NÃO chama provedor — Gmail não existe
 * neste caminho. Idempotente: lote PREPARADO existente é devolvido sem
 * duplicar evento. Escopo: operator_id da sessão (alheio → null → 404).
 */
export async function prepararLoteCampanha(
  pool: CampanhaPool,
  comando: {
    readonly operatorId: string;
    readonly campanhaId: string;
    /** Política da fronteira ÚNICA (carregarPoliticaCampanhaAtualizacao). */
    readonly politica: PfUpdateCampaignPolicy;
  },
): Promise<ResultadoPrepararLoteCampanha | null> {
  let resultado: ResultadoPrepararLoteCampanha | null = null;
  await executarTransacao(pool, async (transaction) => {
    const campanha = await transaction.query(
      `SELECT id FROM campanha_persistida c
        WHERE c.id = $1 AND c.operator_id = $2
        FOR UPDATE OF c`,
      [comando.campanhaId, comando.operatorId],
    );
    if (!campanha.rows[0]) {
      resultado = null;
      return;
    }
    const lote = await transaction.query(
      `SELECT id, codigo, estado, total_itens FROM lote_campanha
        WHERE campanha_id = $1
        FOR UPDATE`,
      [comando.campanhaId],
    );
    const linha = lote.rows[0] as
      | { id: string; codigo: string; estado: string; total_itens: number }
      | undefined;
    if (!linha) {
      resultado = null;
      return;
    }
    if (linha.estado === "PREPARADO" || linha.estado === "ATIVO") {
      resultado = {
        resultado: "EXISTENTE",
        campanhaId: comando.campanhaId,
        loteCampanhaId: linha.id,
        loteCodigo: linha.codigo,
        totalItens: Number(linha.total_itens),
      };
      return;
    }
    if (linha.estado !== "HOLD") {
      throw new CampaignControlError(
        "CAMPAIGN_PREPARE_INVALID_STATE",
        "Lote da campanha não está em estado preparável.",
      );
    }
    const acao = avaliarAcaoOperacaoCampanha({
      acao: "PREPARAR_LOTE",
      politica: comando.politica,
      loteEstado: linha.estado,
      totalItens: Number(linha.total_itens),
      autorizacaoHumanaConcedida: false,
    });
    if (!acao.permitida) {
      throw new CampaignControlError(
        "CAMPAIGN_PREPARE_BLOCKED",
        "Preparação bloqueada por política/estado: " + acao.bloqueios.join(","),
      );
    }
    const agora = new Date().toISOString();
    await transaction.query(
      `UPDATE outbox_campanha o SET estado = 'PREPARADO'
        FROM lote_campanha l
        WHERE o.lote_campanha_id = l.id AND l.id = $1 AND l.estado = 'HOLD' AND o.estado = 'HOLD'`,
      [linha.id],
    );
    await transaction.query(
      `UPDATE lote_campanha SET estado = 'PREPARADO' WHERE id = $1 AND estado = 'HOLD'`,
      [linha.id],
    );
    await transaction.query(
      `INSERT INTO evento_auditoria (
        id, agregado_tipo, agregado_id, tipo, operator_id, ator_operator_id,
        ocorreu_em, metadados, hash_anterior, hash_evento
      ) VALUES ($1, 'CAMPANHA_EXECUCAO', $2, 'CAMPANHA_LOTE_PREPARADO', $3, $3, $4, $5::jsonb, NULL, $6)`,
      [
        randomUUID(),
        linha.id,
        comando.operatorId,
        agora,
        JSON.stringify({
          esquema: "CAMPANHA_CONTROLE_V1",
          acao: "PREPARAR_LOTE",
          total_itens: Number(linha.total_itens),
        }),
        hashEventoControle(linha.id, agora),
      ],
    );
    resultado = {
      resultado: "PREPARADO",
      campanhaId: comando.campanhaId,
      loteCampanhaId: linha.id,
      loteCodigo: linha.codigo,
      totalItens: Number(linha.total_itens),
    };
  });
  return resultado;
}

export type ResultadoAutorizarExecucaoCampanha =
  | {
      readonly resultado: "AUTORIZADO";
      readonly campanhaId: string;
      readonly loteCampanhaId: string;
      readonly totalItens: number;
      /** Referência auditada da emissão (id do evento; entra no nonce da prova). */
      readonly referencia: string;
    }
  | {
      readonly resultado: "JA_AUTORIZADO";
      readonly campanhaId: string;
      readonly loteCampanhaId: string;
      readonly totalItens: number;
      readonly referencia: string;
    };

/**
 * AUTORIZAÇÃO HUMANA de execução (lote PREPARADO): emite o evento append-only
 * CAMPANHA_EXECUCAO_AUTORIZADA e devolve a referência que alimenta o nonce
 * da prova humana (emitirProvaAutorizacaoHumanaCampanha). NÃO ativa o lote,
 * NÃO captura item, NÃO chama provedor. Idempotente: autorização vigente é
 * devolvida (JA_AUTORIZADO) sem segundo evento. A prova humana EXIGE item:
 * a emissão por lote cria o vínculo auditado; a prova por item é derivada
 * da referência + dados do item revalidados no servidor.
 */
export async function autorizarExecucaoCampanha(
  pool: CampanhaPool,
  comando: {
    readonly operatorId: string;
    readonly campanhaId: string;
    /** Política da fronteira ÚNICA (carregarPoliticaCampanhaAtualizacao). */
    readonly politica: PfUpdateCampaignPolicy;
  },
): Promise<ResultadoAutorizarExecucaoCampanha | null> {
  let resultado: ResultadoAutorizarExecucaoCampanha | null = null;
  await executarTransacao(pool, async (transaction) => {
    const campanha = await transaction.query(
      `SELECT id FROM campanha_persistida c
        WHERE c.id = $1 AND c.operator_id = $2
        FOR UPDATE OF c`,
      [comando.campanhaId, comando.operatorId],
    );
    if (!campanha.rows[0]) {
      resultado = null;
      return;
    }
    const lote = await transaction.query(
      `SELECT id, codigo, estado, total_itens FROM lote_campanha
        WHERE campanha_id = $1
        FOR UPDATE`,
      [comando.campanhaId],
    );
    const linha = lote.rows[0] as
      | { id: string; codigo: string; estado: string; total_itens: number }
      | undefined;
    if (!linha) {
      resultado = null;
      return;
    }
    const vigente = await transaction.query(
      `SELECT id FROM evento_auditoria
        WHERE agregado_tipo = 'CAMPANHA_EXECUCAO'
          AND tipo = $1
          AND agregado_id = $2
        ORDER BY sequencia DESC LIMIT 1`,
      [CODIGO_EVENTO_AUTORIZACAO, linha.id],
    );
    const referenciaVigente =
      (vigente.rows[0] as { id: string } | undefined)?.id ?? null;
    if (referenciaVigente) {
      resultado = {
        resultado: "JA_AUTORIZADO",
        campanhaId: comando.campanhaId,
        loteCampanhaId: linha.id,
        totalItens: Number(linha.total_itens),
        referencia: referenciaVigente,
      };
      return;
    }
    const acao = avaliarAcaoOperacaoCampanha({
      acao: "AUTORIZAR_EXECUCAO",
      politica: comando.politica,
      loteEstado: linha.estado,
      totalItens: Number(linha.total_itens),
      autorizacaoHumanaConcedida: false,
    });
    if (!acao.permitida) {
      throw new CampaignControlError(
        "CAMPAIGN_AUTHORIZE_BLOCKED",
        "Autorização bloqueada por política/estado: " + acao.bloqueios.join(","),
      );
    }
    const agora = new Date().toISOString();
    const eventoId = randomUUID();
    await transaction.query(
      `INSERT INTO evento_auditoria (
        id, agregado_tipo, agregado_id, tipo, operator_id, ator_operator_id,
        ocorreu_em, metadados, hash_anterior, hash_evento
      ) VALUES ($1, 'CAMPANHA_EXECUCAO', $2, $3, $4, $4, $5, $6::jsonb, NULL, $7)`,
      [
        eventoId,
        linha.id,
        CODIGO_EVENTO_AUTORIZACAO,
        comando.operatorId,
        agora,
        JSON.stringify({
          esquema: "CAMPANHA_CONTROLE_V1",
          acao: ACAO_AUTORIZADA_EXECUCAO,
          lote_estado: linha.estado,
          total_itens: Number(linha.total_itens),
        }),
        hashEventoControle(linha.id, agora),
      ],
    );
    resultado = {
      resultado: "AUTORIZADO",
      campanhaId: comando.campanhaId,
      loteCampanhaId: linha.id,
      totalItens: Number(linha.total_itens),
      referencia: eventoId,
    };
  });
  return resultado;
}

export type ResultadoAtivarLoteCampanha =
  | {
      readonly resultado: "ATIVADO";
      readonly campanhaId: string;
      readonly loteCampanhaId: string;
      readonly loteCodigo: string;
      readonly totalItens: number;
      /** Referência auditada do evento CAMPANHA_CANARIO_SELECIONADO (sem PII). */
      readonly canarioReferencia: string;
    }
  | {
      readonly resultado: "JA_ATIVADO";
      readonly campanhaId: string;
      readonly loteCampanhaId: string;
      readonly loteCodigo: string;
      readonly totalItens: number;
      readonly canarioReferencia: string;
    };

/**
 * SLICE-03C.1 — ATIVAÇÃO EXPLÍCITA do lote (PREPARADO → ATIVO), transacional
 * e fail-closed. A ativação NÃO envia: apenas liga o lote ao motor 03A, que
 * permanece BLOQUEADO no runtime (execute-attempt sem provider). Contrato:
 * ownership server-side; operador ativo com papel EXECUTOR; canExecute=true
 * com realSendEnabled=false OBRIGATÓRIO durante a ativação; lote PREPARADO;
 * autorização humana vigente; proofKeyReady; exatamente um destinatário
 * canário derivado EXCLUSIVAMENTE da configuração server-side + banco
 * (itens PREPARADO do lote do operador); eventos append-only
 * CAMPANHA_CANARIO_SELECIONADO e CAMPANHA_LOTE_ATIVADO na MESMA transação;
 * CAS PREPARADO → ATIVO; itens permanecem PREPARADO (nenhum ENFILEIRADO);
 * idempotente (lote ATIVO devolve o MESMO canário sem duplicar eventos);
 * alheio/inexistente → null → 404 sanitizado; HOLD/CANCELADO bloqueados;
 * concorrência (FOR UPDATE) concede exatamente uma ativação. A metadata do
 * canário contém apenas item_id/ordem/esquema — NUNCA e-mail ou fingerprint.
 */
export async function ativarLoteCampanha(
  pool: CampanhaPool,
  comando: {
    readonly operatorId: string;
    readonly campanhaId: string;
    /** Política da fronteira ÚNICA (carregarPoliticaCampanhaAtualizacao). */
    readonly politica: PfUpdateCampaignPolicy;
    /** Papéis do operador resolvidos server-side pela sessão (rota). */
    readonly papeisOperador: readonly string[];
  },
  contexto: { readonly chaveProva?: Buffer } = {},
): Promise<ResultadoAtivarLoteCampanha | null> {
  if (!comando.papeisOperador.includes("EXECUTOR")) {
    throw new CampaignControlError(
      "CAMPAIGN_ACTIVATE_ROLE_REQUIRED",
      "Ativação exige papel operacional EXECUTOR.",
    );
  }
  const configuracaoChave = resolverChaveProva(contexto);
  const configuracaoCanario = lerConfiguracaoCanarioCampanha();
  let resultado: ResultadoAtivarLoteCampanha | null = null;
  await executarTransacao(pool, async (transaction) => {
    // Ordem de bloqueio consistente lote→outbox/eventos: campanha primeiro.
    const campanha = await transaction.query(
      `SELECT id FROM campanha_persistida c
        WHERE c.id = $1 AND c.operator_id = $2
        FOR UPDATE OF c`,
      [comando.campanhaId, comando.operatorId],
    );
    if (!campanha.rows[0]) {
      resultado = null;
      return;
    }
    const lote = await transaction.query(
      `SELECT id, codigo, estado, total_itens FROM lote_campanha
        WHERE campanha_id = $1
        FOR UPDATE`,
      [comando.campanhaId],
    );
    const linha = lote.rows[0] as
      | { id: string; codigo: string; estado: string; total_itens: number }
      | undefined;
    if (!linha) {
      resultado = null;
      return;
    }
    if (linha.estado === "ATIVO") {
      // Idempotência: devolve o MESMO canário, sem duplicar evento nenhum.
      const canarioExistente = await transaction.query(
        `SELECT id FROM evento_auditoria
          WHERE agregado_tipo = 'CAMPANHA_EXECUCAO'
            AND tipo = $1
            AND agregado_id = $2
          ORDER BY sequencia DESC LIMIT 1`,
        [CODIGO_EVENTO_CANARIO, linha.id],
      );
      const referenciaCanario =
        (canarioExistente.rows[0] as { id: string } | undefined)?.id ?? null;
      if (!referenciaCanario) {
        throw new CampaignControlError(
          "CAMPAIGN_ACTIVATE_INCONSISTENTE",
          "Lote ATIVO sem canário selecionado — estado inconsistente recusado.",
        );
      }
      resultado = {
        resultado: "JA_ATIVADO",
        campanhaId: comando.campanhaId,
        loteCampanhaId: linha.id,
        loteCodigo: linha.codigo,
        totalItens: Number(linha.total_itens),
        canarioReferencia: referenciaCanario,
      };
      return;
    }
    const canarioPrevio = await transaction.query(
      `SELECT id FROM evento_auditoria
        WHERE agregado_tipo = 'CAMPANHA_EXECUCAO'
          AND tipo = $1
          AND agregado_id = $2
        LIMIT 1`,
      [CODIGO_EVENTO_CANARIO, linha.id],
    );
    const autorizacao = await transaction.query(
      `SELECT id FROM evento_auditoria
        WHERE agregado_tipo = 'CAMPANHA_EXECUCAO'
          AND tipo = $1
          AND agregado_id = $2
        ORDER BY sequencia DESC LIMIT 1`,
      [CODIGO_EVENTO_AUTORIZACAO, linha.id],
    );
    const referenciaVigente =
      (autorizacao.rows[0] as { id: string } | undefined)?.id ?? null;
    const acao = avaliarAcaoOperacaoCampanha({
      acao: "ATIVAR_LOTE",
      politica: comando.politica,
      loteEstado: linha.estado,
      totalItens: Number(linha.total_itens),
      autorizacaoHumanaConcedida: referenciaVigente !== null,
      proofKeyReady: configuracaoChave.proofKeyReady,
      canaryRecipientConfigured: configuracaoCanario.canaryRecipientConfigured,
      canarySelecionado: canarioPrevio.rows.length > 0,
      realSendEnabled: comando.politica.realSendEnabled,
    });
    if (!acao.permitida) {
      throw new CampaignControlError(
        "CAMPAIGN_ACTIVATE_BLOCKED",
        "Ativação bloqueada por política/estado/configuração: " + acao.bloqueios.join(","),
      );
    }
    // EXATAMENTE UM destinatário controlado: apenas itens PREPARADO do lote
    // do operador, pela fingerprint canônica configurada server-side. Zero
    // correspondências e múltiplas correspondências bloqueiam (sanitizado).
    const candidatos = await transaction.query(
      `SELECT i.id, i.ordem FROM outbox_campanha i
        WHERE i.lote_campanha_id = $1
          AND i.estado = 'PREPARADO'
          AND i.destinatario_fingerprint = $2
        ORDER BY i.ordem
        LIMIT 2`,
      [linha.id, configuracaoCanario.fingerprint],
    );
    if (candidatos.rows.length === 0) {
      throw new CampaignControlError(
        "CANARY_RECIPIENT_NOT_FOUND",
        "Nenhum item corresponde ao destinatário canário configurado.",
      );
    }
    if (candidatos.rows.length > 1) {
      throw new CampaignControlError(
        "CANARY_RECIPIENT_AMBIGUOUS",
        "Mais de um item corresponde ao destinatário canário — seleção bloqueada.",
      );
    }
    const canario = candidatos.rows[0] as { id: string; ordem: number };
    const agora = new Date().toISOString();
    // Evento do canário (metadata SANITIZADA: item_id/ordem/esquema — sem
    // e-mail, sem fingerprint, sem valor de configuração).
    const eventoCanarioId = randomUUID();
    await transaction.query(
      `INSERT INTO evento_auditoria (
        id, agregado_tipo, agregado_id, tipo, operator_id, ator_operator_id,
        ocorreu_em, metadados, hash_anterior, hash_evento
      ) VALUES ($1, 'CAMPANHA_EXECUCAO', $2, $3, $4, $4, $5, $6::jsonb, NULL, $7)`,
      [
        eventoCanarioId,
        linha.id,
        CODIGO_EVENTO_CANARIO,
        comando.operatorId,
        agora,
        JSON.stringify({
          esquema: "CAMPANHA_CANARIO_V1",
          item_id: canario.id,
          ordem: Number(canario.ordem),
        }),
        hashEventoControle(linha.id, agora),
      ],
    );
    // CAS durável PREPARADO → ATIVO (defesa adicional ao FOR UPDATE).
    const cas = await transaction.query(
      `UPDATE lote_campanha SET estado = 'ATIVO'
        WHERE id = $1 AND estado = 'PREPARADO'`,
      [linha.id],
    );
    if ((cas.rowCount ?? 0) !== 1) {
      throw new CampaignControlError(
        "CAMPAIGN_ACTIVATE_CONCORRENTE",
        "Ativação concorrente detectada — apenas uma é concedida.",
      );
    }
    await transaction.query(
      `INSERT INTO evento_auditoria (
        id, agregado_tipo, agregado_id, tipo, operator_id, ator_operator_id,
        ocorreu_em, metadados, hash_anterior, hash_evento
      ) VALUES ($1, 'CAMPANHA_EXECUCAO', $2, $3, $4, $4, $5, $6::jsonb, NULL, $7)`,
      [
        randomUUID(),
        linha.id,
        CODIGO_EVENTO_ATIVACAO,
        comando.operatorId,
        agora,
        JSON.stringify({
          esquema: "CAMPANHA_CONTROLE_V1",
          acao: "ATIVAR_LOTE",
          total_itens: Number(linha.total_itens),
          canario_ordem: Number(canario.ordem),
        }),
        hashEventoControle(linha.id, agora),
      ],
    );
    resultado = {
      resultado: "ATIVADO",
      campanhaId: comando.campanhaId,
      loteCampanhaId: linha.id,
      loteCodigo: linha.codigo,
      totalItens: Number(linha.total_itens),
      canarioReferencia: eventoCanarioId,
    };
  });
  return resultado;
}
