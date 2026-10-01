/**
 * SLICE-03A.1 — Fundação de EXECUÇÃO da Campanha PF (local, NO SEND).
 *
 * Mudanças do endurecimento 03A.1:
 *   · Política tipada por INJEÇÃO (PolíticaExecucaoCampanha recebida na
 *     chamada). Este módulo NÃO consulta o ambiente: a fronteira única
 *     continua sendo carregarPoliticaCampanhaAtualizacao (campaigns.ts),
 *     que agora também interpreta PF_CAMPAIGN_EXECUTE_ENABLED — os mesmos
 *     valores servem para /status, frontend e execução.
 *   · Superfície pública ÚNICA: executeAttemptCampanha. claim/provider/
 *     receipt/settlement são INTERNOS — nenhuma rota futura consegue
 *     chamar o provider ignorando a política completa.
 *   · Corrida do lote bloqueada: o CAS do claim exige
 *     lote='ATIVO' AND item='PREPARADO' atomically no mesmo UPDATE
 *     (lote cancelado a meio do claim NÃO concede execução).
 *   · HOLD não é capturável; item concluído não é recapturável; resultado
 *     ambíguo exige reconciliação humana (auto_retry=false no evento).
 *   · Segregação: lote com código do piloto é rejeitado (constante do
 *     módulo neutro pilot-domain; NENHUM import de pilot.ts).
 *   · Auditoria: evento_auditoria (append-only, 0001), agregado
 *     CAMPANHA_EXECUCAO; metadados sanitizados.
 *   · Zero rede: provider é porta abstrata; nenhuma implementação de rede.
 *
 * Máquina de estados (schema 0007 INALTERADO — MIGRATION_REQUIRED=false):
 *   lote:  HOLD|PREPARADO|ATIVO|CANCELADO   (saída de HOLD = ativação humana futura)
 *   item:  HOLD|PREPARADO→ENFILEIRADO→ENVIADO/FALHOU; CANCELADO
 *          FALHOU carrega a classe no evento: PRE_PROVIDER|DEFINITIVA|AMBIGUA
 *
 * Idempotência: chave derivada de dados imutáveis do item, namespace
 * "PF-CAMP-EXEC-V1", sem Session Storage nem memória. Estado persistido
 * (outbox_campanha.estado) é a autoridade durável do claim; evento_auditoria
 * reconstrói a natureza do resultado após restart (classe no payload EXEC_*).
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { RESERVED_PILOT_BATCH_CODE } from "./pilot-domain.js";
import type { CampanhaPool, CampanhaSqlExecutor } from "./campaign-persistence.js";

export type { CampanhaPool, CampanhaSqlExecutor } from "./campaign-persistence.js";
import type { PfUpdateCampaignPolicy } from "./campaigns.js";

// ---------------------------------------------------------------------------
// Política de execução — AUTORIDADE ÚNICA (Slice-03A.1)
// O módulo recebe a política tipada por INJEÇÃO (PfUpdateCampaignPolicy,
// interpretada exclusivamente por carregarPoliticaCampanhaAtualizacao).
// canExecute aqui significa "PF_CAMPAIGN_EXECUTE_ENABLED=true" conforme a
// fronteira; o duplo gate com realSendEnabled é avaliado na elegibilidade.
// NENHUMA função deste módulo consulta o ambiente.
// ---------------------------------------------------------------------------

export type PoliticaExecucaoCampanha = PfUpdateCampaignPolicy;

// ---------------------------------------------------------------------------
// Elegibilidade (pura — bloqueios sanitizados)
// ---------------------------------------------------------------------------

/**
 * SLICE-03C.2B1D — registry de templates (pacote mail, módulo puro): o claim
 * resolve a versão CONGELADA no lote e bloqueia (fail-closed, sem evento e
 * sem mutação) versão não registrada, DRAFT, RETIRED ou de escopo diverso —
 * ANTES do CAS. O provider NUNCA aceita conteúdo ou versão do request.
 */
import {
  contentHashDoTemplate,
  resolverRendererTemplate,
  type TemplateErrorCode,
} from "@integra-correios/mail";
// GF-3 CORRECTIVE-02 (F8) — dispatcher canônico do hash de aprovação
// (produção): a revalidação pré-claim NÃO duplica algoritmo, resolve o
// contrato FAIL-CLOSED e recalcula sobre o snapshot congelado.
import {
  CAMPANHA_APROVACAO_V1,
  CAMPANHA_APROVACAO_V2,
  hashDoSnapshotCampanha,
  resolverContratoHashAprovacao,
  type CampaignPersistSnapshot,
} from "./campaigns.js";

export type BloqueioExecucao =
  | "EXECUTE_DISABLED"
  | "REAL_SEND_DISABLED"
  | "LOTE_NAO_ATIVO"
  | "ITEM_NAO_PREPARADO"
  | "ITEM_CONCLUIDO"
  | "DOMINIO_PILOTO_REJEITADO"
  | "PROVA_DESTINATARIO_AUSENTE"
  | "AUTORIZACAO_HUMANA_AUSENTE"
  | TemplateErrorCode
  | "SNAPSHOT_CORROMPIDO"
  | "APPROVAL_REVALIDACAO_FALHOU";

export interface EntradaElegibilidadeExecucao {
  readonly politica: PoliticaExecucaoCampanha;
  readonly loteEstado: string;
  readonly itemEstado: string;
  /** Código do lote; o código reservado do piloto é rejeitado (segregação). */
  readonly codigoLote: string;
  /** Provas de autorização operacional (fail-closed quando ausentes/false). */
  readonly provas: ProvasAutorizacaoExecucao;
}

export interface AvaliacaoElegibilidadeExecucao {
  readonly elegivel: boolean;
  readonly bloqueios: readonly BloqueioExecucao[];
}

/**
 * Provas de AUTORIZAÇÃO OPERACIONAL (Slice-03A.2) — ainda SEM emissor em
 * produção. São pré-condições OBRIGATÓRIAS antes de qualquer claim:
 *   · recipientProofVerified — destinatário controlado comprovado e
 *     fingerprint conferido por verificador server-side (03B);
 *   · humanAuthorizationVerified — autorização humana ESPECÍFICA do item,
 *     atestada server-side (nunca booleano enviado pelo cliente).
 * Flags de configuração + estados ATIVO/PREPARADO são NECESSÁRIOS mas NÃO
 * SUFICIENTES: sem estas provas o claim é fail-closed (zero mutação, zero
 * provider). Os testes injetam provas SINTÉTICAS apenas para exercitar o
 * domínio; o mecanismo emissor NÃO é implementado nesta fatia.
 */
export interface ProvasAutorizacaoExecucao {
  /** Destinatário controlado comprovado + fingerprint conferido (server-side). */
  readonly recipientProofVerified: boolean;
  /** Autorização humana específica atestada server-side (nunca do request). */
  readonly humanAuthorizationVerified: boolean;
}

const ITENS_TERMINAIS_EXECUCAO: ReadonlySet<string> = new Set([
  "ENVIADO",
  "FALHOU",
  "CANCELADO",
]);

/**
 * Contrato de execução: lote EXATAMENTE ATIVO e item EXATAMENTE PREPARADO.
 * Todo e qualquer outro par de estados nega (matriz completa testada).
 */
export function avaliarElegibilidadeExecucaoItem(
  entrada: EntradaElegibilidadeExecucao,
): AvaliacaoElegibilidadeExecucao {
  const bloqueios: BloqueioExecucao[] = [];
  if (!entrada.politica.canExecute) bloqueios.push("EXECUTE_DISABLED");
  if (!entrada.politica.realSendEnabled) bloqueios.push("REAL_SEND_DISABLED");
  if (!entrada.provas.recipientProofVerified) {
    bloqueios.push("PROVA_DESTINATARIO_AUSENTE");
  }
  if (!entrada.provas.humanAuthorizationVerified) {
    bloqueios.push("AUTORIZACAO_HUMANA_AUSENTE");
  }
  if (entrada.codigoLote === RESERVED_PILOT_BATCH_CODE) {
    bloqueios.push("DOMINIO_PILOTO_REJEITADO");
  }
  if (entrada.loteEstado !== "ATIVO") bloqueios.push("LOTE_NAO_ATIVO");
  if (entrada.itemEstado === "PREPARADO") {
    // único estado elegível — sujeito a todos os demais gates
  } else if (ITENS_TERMINAIS_EXECUCAO.has(entrada.itemEstado)) {
    bloqueios.push("ITEM_CONCLUIDO");
  } else {
    bloqueios.push("ITEM_NAO_PREPARADO");
  }
  return { elegivel: bloqueios.length === 0, bloqueios };
}

// ---------------------------------------------------------------------------
// Idempotência — identidade derivada de dados imutáveis do item
// ---------------------------------------------------------------------------

export interface EntradaChaveIdempotencia {
  readonly campanhaId: string;
  readonly loteCampanhaId: string;
  readonly itemId: string;
  readonly destinatarioFingerprint: string;
  readonly hashAprovacao: string;
}

/**
 * Serialização canônica: separadores \\x1f (unit separator) + terminador \\n
 * por campo — concatenação ambígua é impossível (valores UUID/hash são
 * hex puro, mas o separador de unidade blindaria mesmo campos livres).
 * SHA-256 do canônico namespaced "PF-CAMP-EXEC-V1". Sem memória, sem
 * navegador, sem e-mail/PII em claro.
 */
export function chaveIdempotenciaExecucao(entrada: EntradaChaveIdempotencia): string {
  const sha256 = createHash("sha256");
  sha256.update("PF-CAMP-EXEC-V1\\n");
  for (const campo of [
    entrada.campanhaId,
    entrada.loteCampanhaId,
    entrada.itemId,
    entrada.destinatarioFingerprint,
    entrada.hashAprovacao,
  ]) {
    sha256.update(campo);
    sha256.update("\\u001f\\n");
  }
  return sha256.digest("hex");
}

// ---------------------------------------------------------------------------
// Provider abstrato + FAKE determinístico (ZERO rede; SEMPRE injetado)
// ---------------------------------------------------------------------------

export interface ReceiptEnvioCampanha {
  readonly provider: string;
  readonly messageId: string;
  readonly acceptedAt: string;
  readonly chaveIdempotencia: string;
}

export type ResultadoProvedorCampanha =
  | { readonly tipo: "ENVIADO"; readonly receipt: ReceiptEnvioCampanha }
  | { readonly tipo: "FALHA_PRE_PROVIDER"; readonly motivo: string }
  | { readonly tipo: "FALHA_DEFINITIVA"; readonly motivo: string }
  | { readonly tipo: "AMBIGUO"; readonly motivo: string };

export interface ComandoEnvioCampanha {
  readonly itemId: string;
  readonly chaveIdempotencia: string;
  readonly destinatarioFingerprint: string;
}

/**
 * Porta do provider: a implementação real futura pluga AQUI — e somente aqui.
 * Não há provider default; o fake é injetado explicitamente pelos testes.
 */
export interface ProvedorEnvioCampanha {
  readonly nome: string;
  enviar(comando: ComandoEnvioCampanha): Promise<ResultadoProvedorCampanha>;
}

type RoteiroFake =
  | { readonly tipo: "ENVIADO" }
  | { readonly tipo: "FALHA_PRE_PROVIDER" }
  | { readonly tipo: "FALHA_DEFINITIVA" }
  | { readonly tipo: "AMBIGUO" };

export class ProvedorFakeCampanha implements ProvedorEnvioCampanha {
  readonly nome = "CAMPANHA_FAKE";
  private readonly roteiro: readonly RoteiroFake[];
  private _chamadas = 0;

  constructor(roteiro: readonly RoteiroFake[] = [{ tipo: "ENVIADO" }]) {
    this.roteiro = roteiro;
  }

  get chamadas(): number {
    return this._chamadas;
  }

  async enviar(comando: ComandoEnvioCampanha): Promise<ResultadoProvedorCampanha> {
    this._chamadas += 1;
    const passo = this.roteiro[Math.min(this._chamadas - 1, this.roteiro.length - 1)]!;
    if (passo.tipo === "ENVIADO") {
      return {
        tipo: "ENVIADO",
        receipt: {
          provider: this.nome,
          messageId: "campfake-" + comando.chaveIdempotencia.slice(0, 24),
          acceptedAt: new Date().toISOString(),
          chaveIdempotencia: comando.chaveIdempotencia,
        },
      };
    }
    return { tipo: passo.tipo, motivo: "FAKE_" + passo.tipo };
  }
}

// ---------------------------------------------------------------------------
// Interno — auditoria append-only (evento_auditoria, trigger 0001)
// ---------------------------------------------------------------------------

/**
 * Hash determinístico do evento (recomputável após restart a partir de
 * campos persistidos e independentes da ordem de chaves do JSONB):
 * HMAC(itemId, tipo, ocorreuEm, nonce). O nonce (UUID) viaja DENTRO do
 * metadados persistido e garante unicidade de hash_evento mesmo em
 * rejeições repetidas do mesmo item no mesmo milissegundo.
 */
function hashEventoExecucao(
  itemId: string,
  tipo: string,
  ocorreuEm: string,
  nonce: string,
): string {
  return createHmac("sha256", "audit-chain")
    .update(itemId)
    .update(tipo)
    .update(ocorreuEm)
    .update(nonce)
    .digest("hex");
}

export type TipoEventoExecucao =
  | "EXEC_CLAIM"
  | "EXEC_CLAIM_REJEITADO"
  | "EXEC_TENTATIVA_INICIADA"
  | "EXEC_RECEIPT"
  | "EXEC_SETTLEMENT"
  | "EXEC_FALHA_PRE_PROVIDER"
  | "EXEC_FALHA_DEFINITIVA"
  | "EXEC_AMBIGUO";

async function registrarEventoExecucao(
  executor: CampanhaSqlExecutor,
  entrada: {
    readonly itemId: string;
    readonly tipo: TipoEventoExecucao;
    readonly operatorId: string;
    readonly metadados: Record<string, unknown>;
    readonly agora: string;
  },
): Promise<void> {
  // Payload versionado (esquema) + nonce de unicidade — sanitizados.
  const metadados = {
    esquema: "EXEC_EVENTO_V1",
    ...entrada.metadados,
    nonce: randomUUID(),
  };
  await executor.query(
    "INSERT INTO evento_auditoria (id, agregado_tipo, agregado_id, tipo, operator_id, ator_operator_id, ocorreu_em, metadados, hash_anterior, hash_evento) VALUES ($1, 'CAMPANHA_EXECUCAO', $2, $3, $4, $4, $5, $6::jsonb, NULL, $7)",
    [
      randomUUID(),
      entrada.itemId,
      entrada.tipo,
      entrada.operatorId,
      entrada.agora,
      JSON.stringify(metadados),
      hashEventoExecucao(
        entrada.itemId,
        entrada.tipo,
        entrada.agora,
        metadados.nonce,
      ),
    ],
  );
}

export class CampaignExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CampaignExecutionError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// INTERNO — claim atômico com revalidação transacional do lote
// ---------------------------------------------------------------------------

export type ResultadoClaimExecucao =
  | {
      readonly resultado: "CLAIMADO";
      readonly itemId: string;
      readonly chaveIdempotencia: string;
    }
  | {
      readonly resultado: "BLOQUEADO";
      readonly itemId: string;
      readonly bloqueios: readonly BloqueioExecucao[];
    }
  | { readonly resultado: "NAO_ENCONTRADO"; readonly itemId: string }
  | {
      readonly resultado: "JA_CONCLUIDO";
      readonly itemId: string;
      readonly estado: string;
      readonly chaveIdempotencia: string;
    };

interface LinhaItemExecucao {
  readonly item_estado: string;
  readonly destinatario_fingerprint: string;
  readonly lote_estado: string;
  readonly lote_codigo: string;
  readonly hash_aprovacao: string;
  readonly operator_id: string;
  /** GF-3 CORRECTIVE-02 (F8) — versão congelada na CAMPANHA (c.template_versao). */
  readonly campanha_template_versao?: unknown;
  /** Versão congelada do template (autoridade da resolução do provider). */
  readonly template_versao?: string;
  /** Snapshot congelado da campanha (preflight estrutural — GF-2 FINAL). */
  readonly snapshot_registros?: unknown;
  /** Ordem do item no lote (1-based; posição do registro no snapshot). */
  readonly ordem?: unknown;
}

/**
 * GF-3 CORRECTIVE-02 (F8) — INVENTÁRIO DE INPUTS DO HASH DE APROVAÇÃO V2
 * (RECOMPUTATION_INPUT_COMPLETE): os inputs canônicos do dispatcher de
 * produção (hashAprovacaoCampanha → hashAprovacaoCampanhaV2) são
 *   (1) templateVersao,
 *   (2) templateContentHash,
 *   (3) por registro: profissional_id, nome, email_normalizado,
 *       status_validacao, source_record_key?, exibicao? (8 campos PREFILLED).
 * O snapshot congelado persistido (snapshotCampanha, campaigns.ts) grava
 * EXATAMENTE estes inputs: template_versao, template_content_hash,
 * approval_hash_version e registros[] (com source_record_key?/exibicao?
 * inteiros). Portanto RECOMPUTATION_INPUT_COMPLETE = true — nenhum input
 * durável está ausente, nenhuma migração é necessária e NENHUM hash é
 * inventado. A validação estrutural abaixo rejeita (fail-closed) snapshot
 * sem qualquer um destes inputs.
 *
 * GF-2 FINAL — preflight estrutural do item (exigido ANTES do claim, sem
 * mutação/evento em nenhuma falha): versão registrada/APPROVED no escopo,
 * contentHash do registry presente e snapshot íntegro para a ORDEM do item.
 * GF-3 CORRECTIVE-02 (F8) — REVALIDAÇÃO DA APROVAÇÃO antes de
 * claim/evento/token/provider: aprovação recém-computada ≠ hash persistido ⇒
 * BLOQUEADO (CLAIMS=0, EXEC_EVENTS=0, TOKEN_LOADS=0, PROVIDER_CALLS=0,
 * GMAIL_CALLS=0).
 * Retorno: undefined = OK; string = código de bloqueio sanitizado.
 */
function preflightEstruturalItemExecucao(linha: {
  readonly template_versao?: unknown;
  readonly campanha_template_versao?: unknown;
  readonly hash_aprovacao?: unknown;
  readonly snapshot_registros?: unknown;
  readonly ordem?: unknown;
}): TemplateErrorCode | "SNAPSHOT_CORROMPIDO" | "APPROVAL_REVALIDACAO_FALHOU" | undefined {
  const resolucaoTemplate = resolverRendererTemplate(
    typeof linha.template_versao === "string" ? linha.template_versao : "",
  );
  if (!resolucaoTemplate.ok) return resolucaoTemplate.code;
  if (contentHashDoTemplate(linha.template_versao as string) === undefined) {
    return "SNAPSHOT_CORROMPIDO";
  }
  if (typeof linha.hash_aprovacao !== "string" || linha.hash_aprovacao.length !== 64) {
    return "SNAPSHOT_CORROMPIDO";
  }
  const snapshot = linha.snapshot_registros;
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    !Array.isArray((snapshot as { registros?: unknown }).registros)
  ) {
    return "SNAPSHOT_CORROMPIDO";
  }
  // Visão tipada do snapshot congelado para a revalidação de aprovação (F8).
  const snapshotDados = snapshot as CampaignPersistSnapshot;
  const registros = (snapshot as { registros: readonly unknown[] }).registros;
  const ordem = typeof linha.ordem === "number" ? Math.trunc(linha.ordem) : Number.NaN;
  if (!Number.isInteger(ordem) || ordem < 1 || ordem > registros.length) {
    return "SNAPSHOT_CORROMPIDO";
  }
  // -------------------------------------------------------------------------
  // GF-3 CORRECTIVE-02 (F8) — REVALIDAÇÃO DA APROVAÇÃO ANTES DO CLAIM.
  // Ordem estrita (nenhuma mutação/evento/token/provider pode ocorrer depois
  // de uma divergência): (1) approval_hash_version; (2) estrutura completa do
  // snapshot (todos os inputs canônicos presentes); (3) versões template
  // campanha = lote = snapshot; (4)/(5) contentHash do registry = congelado;
  // (6)/(7) hash recalculado PELO DISPATCHER DE PRODUÇÃO = hash persistido.
  // -------------------------------------------------------------------------
  let contrato: ReturnType<typeof resolverContratoHashAprovacao>;
  try {
    contrato = resolverContratoHashAprovacao({
      templateVersao: linha.template_versao as string,
      approvalHashVersion: snapshotDados.approval_hash_version,
    });
  } catch {
    return "APPROVAL_REVALIDACAO_FALHOU";
  }
  if (contrato !== CAMPANHA_APROVACAO_V2 && contrato !== CAMPANHA_APROVACAO_V1) {
    return "APPROVAL_REVALIDACAO_FALHOU";
  }
  // Estrutura completa do snapshot (RECOMPUTATION_INPUT_COMPLETE=true):
  // sem template_content_hash durável ou registro sem campos canônicos ⇒
  // BLOQUEADO (nada é inventado, nenhuma migração é adicionada aqui).
  if (typeof snapshotDados.template_content_hash !== "string") {
    return "APPROVAL_REVALIDACAO_FALHOU";
  }
  for (const candidato of registros) {
    if (typeof candidato !== "object" || candidato === null) {
      return "APPROVAL_REVALIDACAO_FALHOU";
    }
    const candidatoDados = candidato as {
      profissional_id?: unknown;
      nome?: unknown;
      email_normalizado?: unknown;
      status_validacao?: unknown;
      source_record_key?: unknown;
      exibicao?: unknown;
    };
    if (
      typeof candidatoDados.profissional_id !== "string" ||
      typeof candidatoDados.nome !== "string" ||
      typeof candidatoDados.email_normalizado !== "string" ||
      typeof candidatoDados.status_validacao !== "string"
    ) {
      return "APPROVAL_REVALIDACAO_FALHOU";
    }
    if (
      candidatoDados.source_record_key !== undefined &&
      typeof candidatoDados.source_record_key !== "string"
    ) {
      return "APPROVAL_REVALIDACAO_FALHOU";
    }
    if (
      candidatoDados.exibicao !== undefined &&
      (typeof candidatoDados.exibicao !== "object" || candidatoDados.exibicao === null)
    ) {
      return "APPROVAL_REVALIDACAO_FALHOU";
    }
  }
  // (3) versões: campanha (linha do SELECT) = lote = snapshot congelado.
  if (
    linha.campanha_template_versao !== linha.template_versao ||
    linha.template_versao !== snapshotDados.template_versao
  ) {
    return "APPROVAL_REVALIDACAO_FALHOU";
  }
  // (4)/(5) contentHash canônico ATUAL do registry = congelado no snapshot.
  if (
    contentHashDoTemplate(linha.template_versao as string) !==
    snapshotDados.template_content_hash
  ) {
    return "APPROVAL_REVALIDACAO_FALHOU";
  }
  // (6)/(7) hash do snapshot pelo dispatcher DE PRODUÇÃO = hash persistido.
  // O cast é seguro: a checagem estrutural acima exigiu os inputs canônicos
  // (RECOMPUTATION_INPUT_COMPLETE) e resolverContratoHashAprovacao é
  // fail-closed para o contrato.
  const snapshotCanonicamenteValido = snapshot as CampaignPersistSnapshot;
  if (hashDoSnapshotCampanha(snapshotCanonicamenteValido) !== linha.hash_aprovacao) {
    return "APPROVAL_REVALIDACAO_FALHOU";
  }
  return undefined;
}

function operatorUuidValidoExecucao(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function assertIdsExecucao(entrada: {
  campanhaId: string;
  loteCampanhaId: string;
  itemId: string;
}): void {
  const invalido =
    !operatorUuidValidoExecucao(entrada.campanhaId) ||
    !operatorUuidValidoExecucao(entrada.loteCampanhaId) ||
    !operatorUuidValidoExecucao(entrada.itemId);
  if (invalido) {
    throw new CampaignExecutionError(
      "EXECUTION_INPUT_INVALID",
      "Identificadores devem ser UUID válidos.",
    );
  }
}

/**
 * INTERNO. Claim transacional de UM item.
 *
 * Estratégia anti-corrida do lote (alternativa B reforçada com lock): a
 * transação trava a linha do LOTE primeiro (`FOR UPDATE OF l`) e do item
 * (`FOR UPDATE OF i`) — ordem consistente lote→item em todo o módulo — e o
 * CAS único exige, ATOMICAMENTE, `lote='ATIVO' AND item='PREPARADO'`. Uma
 * transição concorrente de ativação/cancelamento do lote não pode vencer:
 * ou a trava do lote é obtida depois do commit concorrente (e o SELECT vê o
 * estado novo → elegibilidade reavaliada), ou o CAS falha (0 linhas) →
 * ROLLBACK e rejeição. Exatamente uma linha alterada para o vencedor.
 *
 * Transação única: SELECT com lock → revalidação (política injetada +
 * lote ATIVO + item PREPARADO + domínio + ownership) → CAS → auditoria →
 * COMMIT. Rollback em todas as exceções; conexão sempre liberada.
 */
async function claimItemInterno(
  pool: CampanhaPool,
  comando: {
    readonly operatorId: string;
    readonly campanhaId: string;
    readonly loteCampanhaId: string;
    readonly itemId: string;
    readonly politica: PoliticaExecucaoCampanha;
    readonly provas: ProvasAutorizacaoExecucao;
  },
): Promise<ResultadoClaimExecucao> {
  assertIdsExecucao(comando);
  if (!operatorUuidValidoExecucao(comando.operatorId)) {
    throw new CampaignExecutionError(
      "EXECUTION_INPUT_INVALID",
      "operatorId da sessão é obrigatório.",
    );
  }
  const transaction = await pool.connect();
  try {
    await transaction.query("BEGIN");
    const linhas = await transaction.query(
      "SELECT i.estado AS item_estado, i.destinatario_fingerprint, l.estado AS lote_estado, l.codigo AS lote_codigo, c.hash_aprovacao, c.operator_id, l.template_versao, c.template_versao AS campanha_template_versao, c.snapshot_registros, i.ordem FROM lote_campanha l JOIN campanha_persistida c ON c.id = l.campanha_id JOIN outbox_campanha i ON i.lote_campanha_id = l.id WHERE i.id = $1 AND l.id = $2 AND c.id = $3 FOR UPDATE OF l, i",
      [comando.itemId, comando.loteCampanhaId, comando.campanhaId],
    );
    const linha = linhas.rows[0] as
      | (LinhaItemExecucao & { lote_estado: string; lote_codigo: string })
      | undefined;
    if (!linha || linha.operator_id !== comando.operatorId) {
      // Alheio/inexistente indistinguíveis — sem mutação, sem evento.
      await transaction.query("ROLLBACK");
      return { resultado: "NAO_ENCONTRADO", itemId: comando.itemId };
    }

    // SLICE-03C.2B1D / GF-2 FINAL — preflight estrutural ANTES do claim
    // (ROLLBACK sem mutação e sem evento): versão registrada/APPROVED no
    // escopo, contentHash do registry presente e snapshot íntegro para a
    // ORDEM do item. O provider repete verificações como defesa em
    // profundidade (nunca como autoridade primária).
    const bloqueioPreflight = preflightEstruturalItemExecucao(linha);
    if (bloqueioPreflight !== undefined) {
      await transaction.query("ROLLBACK");
      return {
        resultado: "BLOQUEADO",
        itemId: comando.itemId,
        bloqueios: [bloqueioPreflight],
      };
    }

    const agora = new Date().toISOString();
    const avaliacao = avaliarElegibilidadeExecucaoItem({
      politica: comando.politica,
      loteEstado: linha.lote_estado,
      itemEstado: linha.item_estado,
      codigoLote: linha.lote_codigo,
      provas: comando.provas,
    });

    const chave = chaveIdempotenciaExecucao({
      campanhaId: comando.campanhaId,
      loteCampanhaId: comando.loteCampanhaId,
      itemId: comando.itemId,
      destinatarioFingerprint: linha.destinatario_fingerprint,
      hashAprovacao: linha.hash_aprovacao,
    });

    if (avaliacao.bloqueios.includes("ITEM_CONCLUIDO")) {
      await transaction.query("COMMIT");
      return {
        resultado: "JA_CONCLUIDO",
        itemId: comando.itemId,
        estado: linha.item_estado,
        chaveIdempotencia: chave,
      };
    }
    if (!avaliacao.elegivel) {
      await registrarEventoExecucao(transaction, {
        itemId: comando.itemId,
        tipo: "EXEC_CLAIM_REJEITADO",
        operatorId: comando.operatorId,
        metadados: { bloqueios: avaliacao.bloqueios, chave_idempotencia: chave },
        agora,
      });
      await transaction.query("COMMIT");
      return {
        resultado: "BLOQUEADO",
        itemId: comando.itemId,
        bloqueios: avaliacao.bloqueios,
      };
    }

    // CAS duplo — corrida do lote BLOQUEADA atomicamente:
    // só vence quem transforma (lote ATIVO, item PREPARADO) → ENFILEIRADO.
    const cas = await transaction.query(
      "UPDATE outbox_campanha i SET estado = 'ENFILEIRADO' FROM lote_campanha l WHERE i.lote_campanha_id = l.id AND i.id = $1 AND l.id = $2 AND l.estado = 'ATIVO' AND i.estado = 'PREPARADO'",
      [comando.itemId, comando.loteCampanhaId],
    );
    if ((cas.rowCount ?? 0) !== 1) {
      // O lote mudou sob a transação (ou o item mudou): nenhuma concessão.
      await transaction.query("ROLLBACK");
      return { resultado: "NAO_ENCONTRADO", itemId: comando.itemId };
    }
    await registrarEventoExecucao(transaction, {
      itemId: comando.itemId,
      tipo: "EXEC_CLAIM",
      operatorId: comando.operatorId,
      metadados: { chave_idempotencia: chave, lote_estado: linha.lote_estado },
      agora,
    });
    await transaction.query("COMMIT");
    return {
      resultado: "CLAIMADO",
      itemId: comando.itemId,
      chaveIdempotencia: chave,
    };
  } catch (error) {
    try {
      await transaction.query("ROLLBACK");
    } catch {
      // Preserva a causa original.
    }
    throw error;
  } finally {
    transaction.release();
  }
}

// ---------------------------------------------------------------------------
// INTERNO — receipt / settlement / falhas (exatamente uma vez, CAS)
// ---------------------------------------------------------------------------

type ResultadoSettlementInterno =
  | { readonly resultado: "SETTLED"; readonly estado: "ENVIADO" | "FALHOU" }
  | { readonly resultado: "IDEMPOTENTE"; readonly estado: string }
  | { readonly resultado: "NAO_ENCONTRADO" };

async function estadoItemInterno(
  executor: CampanhaSqlExecutor,
  itemId: string,
): Promise<string | null> {
  const linhas = await executor.query(
    "SELECT estado FROM outbox_campanha WHERE id = $1",
    [itemId],
  );
  return (linhas.rows[0] as { estado: string } | undefined)?.estado ?? null;
}

async function registrarReceiptInterno(
  pool: CampanhaPool,
  comando: {
    readonly operatorId: string;
    readonly itemId: string;
    readonly receipt: ReceiptEnvioCampanha;
  },
): Promise<ResultadoSettlementInterno> {
  const transaction = await pool.connect();
  try {
    await transaction.query("BEGIN");
    const atual = await estadoItemInterno(transaction, comando.itemId);
    if (!atual) {
      await transaction.query("ROLLBACK");
      return { resultado: "NAO_ENCONTRADO" };
    }
    if (atual !== "ENFILEIRADO") {
      // Já settled (ou terminal): idempotente — NUNCA segundo receipt.
      await transaction.query("COMMIT");
      return { resultado: "IDEMPOTENTE", estado: atual };
    }
    const agora = new Date().toISOString();
    await registrarEventoExecucao(transaction, {
      itemId: comando.itemId,
      tipo: "EXEC_RECEIPT",
      operatorId: comando.operatorId,
      metadados: {
        provider: comando.receipt.provider,
        message_id: comando.receipt.messageId,
        chave_idempotencia: comando.receipt.chaveIdempotencia,
      },
      agora,
    });
    const cas = await transaction.query(
      "UPDATE outbox_campanha SET estado = 'ENVIADO' WHERE id = $1 AND estado = 'ENFILEIRADO'",
      [comando.itemId],
    );
    if ((cas.rowCount ?? 0) !== 1) {
      await transaction.query("ROLLBACK");
      return { resultado: "IDEMPOTENTE", estado: atual };
    }
    await transaction.query("COMMIT");
    return { resultado: "SETTLED", estado: "ENVIADO" };
  } catch (error) {
    try {
      await transaction.query("ROLLBACK");
    } catch {
      // Preserva a causa original.
    }
    throw error;
  } finally {
    transaction.release();
  }
}

async function terminalizarFalhaInterno(
  pool: CampanhaPool,
  comando: {
    readonly operatorId: string;
    readonly itemId: string;
    readonly classe: "PRE_PROVIDER" | "DEFINITIVA" | "AMBIGUA";
    readonly motivo: string;
  },
): Promise<ResultadoSettlementInterno> {
  const tipoEvento: TipoEventoExecucao =
    comando.classe === "PRE_PROVIDER"
      ? "EXEC_FALHA_PRE_PROVIDER"
      : comando.classe === "DEFINITIVA"
        ? "EXEC_FALHA_DEFINITIVA"
        : "EXEC_AMBIGUO";
  const transaction = await pool.connect();
  try {
    await transaction.query("BEGIN");
    const atual = await estadoItemInterno(transaction, comando.itemId);
    if (!atual) {
      await transaction.query("ROLLBACK");
      return { resultado: "NAO_ENCONTRADO" };
    }
    if (atual !== "ENFILEIRADO") {
      await transaction.query("COMMIT");
      return { resultado: "IDEMPOTENTE", estado: atual };
    }
    const agora = new Date().toISOString();
    await registrarEventoExecucao(transaction, {
      itemId: comando.itemId,
      tipo: tipoEvento,
      operatorId: comando.operatorId,
      metadados: {
        classe: comando.classe,
        motivo: comando.motivo,
        // Resultado ambíguo EXIGE reconciliação humana; sem retry automático.
        ...(comando.classe === "AMBIGUA"
          ? { reconciliacao: "HUMANA", auto_retry: false }
          : {}),
      },
      agora,
    });
    const cas = await transaction.query(
      "UPDATE outbox_campanha SET estado = 'FALHOU' WHERE id = $1 AND estado = 'ENFILEIRADO'",
      [comando.itemId],
    );
    if ((cas.rowCount ?? 0) !== 1) {
      await transaction.query("ROLLBACK");
      return { resultado: "IDEMPOTENTE", estado: atual };
    }
    await transaction.query("COMMIT");
    return { resultado: "SETTLED", estado: "FALHOU" };
  } catch (error) {
    try {
      await transaction.query("ROLLBACK");
    } catch {
      // Preserva a causa original.
    }
    throw error;
  } finally {
    transaction.release();
  }
}

// ---------------------------------------------------------------------------
// PÚBLICO — único entrypoint de execução
// ---------------------------------------------------------------------------

export type ResultadoTentativaExecucao =
  | { readonly resultado: "ENVIADO"; readonly itemId: string; readonly receipt: ReceiptEnvioCampanha }
  | { readonly resultado: "FALHA_PRE_PROVIDER"; readonly itemId: string; readonly motivo: string }
  | { readonly resultado: "FALHA_DEFINITIVA"; readonly itemId: string; readonly motivo: string }
  | { readonly resultado: "AMBIGUO"; readonly itemId: string; readonly motivo: string }
  | { readonly resultado: "NAO_CLAIMADO"; readonly itemId: string; readonly claim: ResultadoClaimExecucao };

export interface ComandoTentativaExecucao {
  /** operator_id resolvido SERVER-SIDE (sessão) — nunca do corpo do request. */
  readonly operatorId: string;
  readonly campanhaId: string;
  readonly loteCampanhaId: string;
  readonly itemId: string;
  /** Política da fronteira ÚNICA (carregarPoliticaCampanhaAtualizacao). */
  readonly politica: PoliticaExecucaoCampanha;
  /**
   * Provas de autorização operacional produzidas por verificadores
   * server-side (03B). NUNCA aceitas diretamente do corpo do request.
   */
  readonly provas: ProvasAutorizacaoExecucao;
  /** Provider explicitamente selecionado — injeção obrigatória, sem default. */
  readonly provider: ProvedorEnvioCampanha;
}

/**
 * ÚNICO entrypoint público. Ordem EXATA dos gates antes do primeiro SQL
 * mutável e antes do provider:
 *   0. versão do template CONGELADA no lote (registry, 03C.2B1D):
 *      DRAFT/RETIRED/desconhecida/incompatível ⇒ BLOQUEADO antes do claim;
 *   1. política de CONFIGURAÇÃO (PF_CAMPAIGN_EXECUTE_ENABLED ∧
 *      REAL_SEND_ENABLED) — NECESSÁRIA, NUNCA suficiente;
 *   2. PROVAS de autorização operacional (destinatário controlado
 *      comprovado + fingerprint conferido + autorização humana específica)
 *      — fail-closed ANTES de qualquer mutação;
 *   3. estado persistido: ownership server-side → lote ATIVO → item
 *      PREPARADO (revalidados atomicamente no CAS do claim);
 *   4. claim atômico → provider injetado → receipt/settlement
 *      exatamente-uma-vez → auditoria append-only.
 * canExecute é SEMÂNTICA DE CONFIGURAÇÃO (CONFIG_ONLY): não autoriza
 * operação real sem as provas do passo 2 — os emissores server-side chegam
 * no 03B (PRODUCTION_PROOF_ISSUER_IMPLEMENTED=false nesta fatia).
 *
 * Fronteiras de crash (restart-safe; decisão só de estado persistido):
 *   A. crash pós-claim/pré-provider  → item ENFILEIRADO: não recapturável;
 *      exige reconciliação humana (nenhum auto-retry, nenhuma memória).
 *   B/C/D. provider sem resposta conclusiva / timeout pós-aceitação →
 *      AMBIGUO → FALHOU + EXEC_AMBIGUO (auto_retry=false) — reconciliação
 *      humana; o evento registrada antes da chamada (EXEC_TENTATIVA_
 *      INICIADA) prova que o provider PODE ter recebido a mensagem.
 *   E. falha pré-provider → FALHOU + EXEC_FALHA_PRE_PROVIDER (sem receipt).
 *   F. falha definitiva → FALHOU + EXEC_FALHA_DEFINITIVA.
 *   G/H/I. repetição pós-ENFILEIRADO/ENVIADO/FALHOU → BLOQUEADO/JA_CONCLUIDO,
 *      provider nunca é chamado novamente.
 *
 * Garantias precisas: transição de settlement AT-MOST-ONCE por item;
 * entrega externa NÃO é exactly-once (NOT_GUARANTEED — pagamento/SMTP não
 * dá para tornar transacional); AMBIGUOUS = reconciliação HUMANA.
 */
export async function executeAttemptCampanha(
  pool: CampanhaPool,
  comando: ComandoTentativaExecucao,
): Promise<ResultadoTentativaExecucao> {
  // Gate antecipado de provas: sem elas, ZERO SQL (nem leitura) e ZERO
  // provider — a revalidação transacional dentro do claim é defesa em
  // profundidade, não substituto deste fail-closed inicial.
  const bloqueiosProva: BloqueioExecucao[] = [];
  if (!comando.provas.recipientProofVerified) {
    bloqueiosProva.push("PROVA_DESTINATARIO_AUSENTE");
  }
  if (!comando.provas.humanAuthorizationVerified) {
    bloqueiosProva.push("AUTORIZACAO_HUMANA_AUSENTE");
  }
  if (bloqueiosProva.length > 0) {
    return {
      resultado: "NAO_CLAIMADO",
      itemId: comando.itemId,
      claim: { resultado: "BLOQUEADO", itemId: comando.itemId, bloqueios: bloqueiosProva },
    };
  }
  const claim = await claimItemInterno(pool, comando);
  if (claim.resultado !== "CLAIMADO") {
    return { resultado: "NAO_CLAIMADO", itemId: comando.itemId, claim };
  }

  const transaction = await pool.connect();
  let fingerprint = "";
  try {
    await transaction.query("BEGIN");
    const linhas = await transaction.query(
      "SELECT destinatario_fingerprint FROM outbox_campanha WHERE id = $1",
      [comando.itemId],
    );
    fingerprint = (linhas.rows[0] as { destinatario_fingerprint: string } | undefined)
      ?.destinatario_fingerprint ?? "";
    await registrarEventoExecucao(transaction, {
      itemId: comando.itemId,
      tipo: "EXEC_TENTATIVA_INICIADA",
      operatorId: comando.operatorId,
      metadados: { provider: comando.provider.nome, chave_idempotencia: claim.chaveIdempotencia },
      agora: new Date().toISOString(),
    });
    await transaction.query("COMMIT");
  } catch (error) {
    try {
      await transaction.query("ROLLBACK");
    } catch {
      // Preserva a causa original.
    }
    throw error;
  } finally {
    transaction.release();
  }

  const saida = await comando.provider.enviar({
    itemId: comando.itemId,
    chaveIdempotencia: claim.chaveIdempotencia,
    destinatarioFingerprint: fingerprint,
  });

  if (saida.tipo === "ENVIADO") {
    const settlement = await registrarReceiptInterno(pool, {
      operatorId: comando.operatorId,
      itemId: comando.itemId,
      receipt: saida.receipt,
    });
    if (settlement.resultado !== "SETTLED") {
      throw new CampaignExecutionError(
        "EXECUTION_SETTLEMENT_INCONSISTENTE",
        "Receipt concedido sem settlement — exige reconciliação humana.",
      );
    }
    const settleTransaction = await pool.connect();
    try {
      await settleTransaction.query("BEGIN");
      await registrarEventoExecucao(settleTransaction, {
        itemId: comando.itemId,
        tipo: "EXEC_SETTLEMENT",
        operatorId: comando.operatorId,
        metadados: {
          chave_idempotencia: claim.chaveIdempotencia,
          estado_final: "ENVIADO",
        },
        agora: new Date().toISOString(),
      });
      await settleTransaction.query("COMMIT");
    } catch (error) {
      // GF-3 CORRECTIVE-01 (F5) — mesma disciplina de rollback do restante do
      // módulo: a conexão NUNCA retorna ao pool com transação aberta/abortada
      // (falha em registrarEventoExecucao OU no COMMIT). A causa original é
      // preservada; o release permanece no finally.
      try {
        await settleTransaction.query("ROLLBACK");
      } catch {
        // Preserva a causa original.
      }
      throw error;
    } finally {
      settleTransaction.release();
    }
    return { resultado: "ENVIADO", itemId: comando.itemId, receipt: saida.receipt };
  }
  if (saida.tipo === "FALHA_PRE_PROVIDER") {
    await terminalizarFalhaInterno(pool, {
      operatorId: comando.operatorId,
      itemId: comando.itemId,
      classe: "PRE_PROVIDER",
      motivo: saida.motivo,
    });
    return { resultado: "FALHA_PRE_PROVIDER", itemId: comando.itemId, motivo: saida.motivo };
  }
  if (saida.tipo === "FALHA_DEFINITIVA") {
    await terminalizarFalhaInterno(pool, {
      operatorId: comando.operatorId,
      itemId: comando.itemId,
      classe: "DEFINITIVA",
      motivo: saida.motivo,
    });
    return { resultado: "FALHA_DEFINITIVA", itemId: comando.itemId, motivo: saida.motivo };
  }
  await terminalizarFalhaInterno(pool, {
    operatorId: comando.operatorId,
    itemId: comando.itemId,
    classe: "AMBIGUA",
    motivo: saida.motivo,
  });
  return { resultado: "AMBIGUO", itemId: comando.itemId, motivo: saida.motivo };
}
