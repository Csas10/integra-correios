/**
 * SLICE-03C.2A — Fundação runtime do canário da Campanha PF (STRICT NO SEND).
 *
 * Este módulo é a ÚNICA fronteira do caminho de envio do canário:
 *   · PREFLIGHT read-only OBRIGATÓRIO antes de executeAttemptCampanha —
 *     qualquer falha ⇒ ZERO claim, ZERO mutação, ZERO evento, ZERO carga de
 *     token, ZERO provider, ZERO rede ("ZERO CLAIM OBRIGATÓRIO");
 *   · resolução canônica do destinatário pelo SNAPSHOT CONGELADO da campanha
 *     (nenhuma PII é copiada para nova coluna; nenhuma migration);
 *   · ProvedorGmailCampanha: implementação runtime do ProvedorEnvioCampanha —
 *     render → GmailMailGateway → transport injetável; revalida o
 *     fingerprint como defesa em profundidade (não substitui o preflight);
 *   · OAuth readiness ESTRITAMENTE read-only (nenhuma rede, nenhum
 *     carregamento/descriptografia de token, nenhum refresh, nenhum Google).
 *
 * Nenhuma leitura direta de PF_CAMPAIGN_CANARY_SEND_ENABLED fora da política
 * (autoridade única: carregarPoliticaCampanhaAtualizacao). O provider NUNCA é
 * selecionável pelo cliente e NENHUM dado do browser entra no caminho.
 */

import { createHash } from "node:crypto";
import {
  CODIGO_EVENTO_ATIVACAO,
  CODIGO_EVENTO_CANARIO,
  emitirProvasServerSideCampanha,
  fingerprintDestinatarioCampanha,
  lerConfiguracaoCanarioCampanha,
  lerConfiguracaoChaveProvaCampanha,
  type CampanhaPool,
} from "./campaign-control.js";
import {
  chaveIdempotenciaExecucao,
  executeAttemptCampanha,
  type ComandoEnvioCampanha,
  type ComandoTentativaExecucao,
  type PoliticaExecucaoCampanha,
  type ProvedorEnvioCampanha,
  type ProvasAutorizacaoExecucao,
  type ResultadoProvedorCampanha,
  type ResultadoTentativaExecucao,
} from "./campaign-execution.js";
import { CampanhaTokenResolutionError } from "./campaign-gmail-runtime.js";
import type { PfUpdateCampaignPolicy } from "./campaigns.js";
import {
  derivarFingerprintContaGmail,
  GmailAmbiguousError,
  GmailAuthError,
  GmailMailGateway,
  GmailPermanentPolicyError,
  GmailRateLimitError,
  loadGmailOauthConfig,
  MailProviderNaoConfiguradoError,
  MailProviderRequestError,
  renderizarTemplatePersistido,
  campoExibicao,
  type MailReceipt,
  type RenderInputCampanha,
  type TemplateErrorCode,
  type OutboundMail,
} from "@integra-correios/mail";

/** Ambiente de leitura estrutural (mesma forma da fronteira do mail). */
type AmbienteLeve = Readonly<Record<string, string | undefined>>;
import type { HmacSha256Fingerprinter } from "@integra-correios/persistence";

// ---------------------------------------------------------------------------
// CorrelationCode — server-side, determinístico e estável por item, opaco,
// sem PII (hex maiúsculo curto). Deriva da chave de idempotência (que já
// vincula campanha/lote/item/fingerprint/hashAprovacao) + itemId — NUNCA
// fornecido pelo browser.
// ---------------------------------------------------------------------------
/**
 * SLICE-03C.2B1D — mapeamento sanitizado de falhas de template para o motivo
 * pré-provider (sem detalhes internos; mesma disciplina dos demais motivos).
 */
export function motivoFalhaTemplateCampanha(code: TemplateErrorCode): string {
  if (code === "CAMPAIGN_TEMPLATE_UNSUPPORTED") return "TEMPLATE_VERSAO_NAO_REGISTRADA";
  if (code === "CAMPAIGN_TEMPLATE_NOT_APPROVED") return "TEMPLATE_NAO_APROVADO";
  return "TEMPLATE_ESCOPO_INCOMPATIVEL";
}

export const CORRELATION_CODE_PREFIX = "PF26" as const;
const CORRELATION_CODE_BYTES = 16 as const; // 16 bytes = 32 hex

export function correlationCodeCanario(entrada: {
  readonly chaveIdempotencia: string;
  readonly itemId: string;
}): string {
  const payload = JSON.stringify([
    "PF-CAMP-CORRELATION-V1",
    entrada.chaveIdempotencia,
    entrada.itemId,
  ]);
  const digest = createHash("sha256").update(payload).digest("hex");
  return `${CORRELATION_CODE_PREFIX}-${digest
    .slice(0, CORRELATION_CODE_BYTES * 2)
    .toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Resolução canônica do destinatário — SNAPSHOT CONGELADO (autoridade 0001).
// outbox_campanha NÃO possui e-mail: ordem → snapshot_registros.registros[ordem-1].
// O recálculo do fingerprint deve bater com a outbox (dupla prova) e, quando
// aplicável, com a configuração do canário (triplo match no preflight).
// Nenhum lookup heurístico; nenhum "primeiro registro"; nenhuma migration.
// ---------------------------------------------------------------------------
export interface DestinatarioResolvidoCanario {
  readonly itemId: string;
  readonly ordem: number;
  readonly profissionalId: string;
  readonly nome: string;
  readonly emailNormalizado: string;
  readonly fingerprintOutbox: string;
  readonly fingerprintRecalculado: string;
  readonly hashAprovacao: string;
}

export type MotivoFalhaResolucao =
  | "ITEM_INEXISTENTE"
  | "SNAPSHOT_INCOMPATIVEL"
  | "FINGERPRINT_DIVERGENTE";

export async function resolverDestinatarioCanario(
  executor: Pick<CampanhaPool, "query">,
  ids: {
    readonly operatorId: string;
    readonly campanhaId: string;
    readonly loteCampanhaId: string;
    readonly itemId: string;
  },
): Promise<DestinatarioResolvidoCanario | MotivoFalhaResolucao> {
  const linhas = await executor.query(
    `SELECT i.ordem, i.destinatario_fingerprint, s.snapshot_registros, s.hash_aprovacao
       FROM outbox_campanha i
       JOIN lote_campanha l ON l.id = i.lote_campanha_id
       JOIN campanha_persistida s ON s.id = l.campanha_id
      WHERE i.id = $1 AND l.id = $2 AND s.id = $3 AND s.operator_id = $4`,
    [ids.itemId, ids.loteCampanhaId, ids.campanhaId, ids.operatorId],
  );
  const linha = linhas.rows[0] as
    | {
        ordem: number;
        destinatario_fingerprint: string;
        hash_aprovacao: string;
        snapshot_registros: {
          registros?: readonly {
            profissional_id?: unknown;
            nome?: unknown;
            email_normalizado?: unknown;
          }[];
        };
      }
    | undefined;
  if (!linha) return "ITEM_INEXISTENTE";
  const registros = linha.snapshot_registros.registros ?? [];
  const indice = Number(linha.ordem) - 1;
  const registro = registros[indice];
  if (!registro) return "SNAPSHOT_INCOMPATIVEL";
  const profissionalId = typeof registro.profissional_id === "string" ? registro.profissional_id.trim() : "";
  const nome = typeof registro.nome === "string" ? registro.nome.trim() : "";
  const emailNormalizado = typeof registro.email_normalizado === "string" ? registro.email_normalizado.trim() : "";
  if (!profissionalId || !nome || !emailNormalizado) return "SNAPSHOT_INCOMPATIVEL";
  const fingerprintRecalculado = fingerprintDestinatarioCampanha(emailNormalizado);
  const fingerprintOutbox = String(linha.destinatario_fingerprint);
  if (fingerprintRecalculado !== fingerprintOutbox) return "FINGERPRINT_DIVERGENTE";
  return {
    itemId: ids.itemId,
    ordem: Number(linha.ordem),
    profissionalId,
    nome,
    emailNormalizado,
    fingerprintOutbox,
    fingerprintRecalculado,
    hashAprovacao: String(linha.hash_aprovacao),
  };
}

export function isDestinatarioResolvido(
  resultado: DestinatarioResolvidoCanario | MotivoFalhaResolucao,
): resultado is DestinatarioResolvidoCanario {
  return typeof resultado === "object" && resultado !== null && "emailNormalizado" in resultado;
}

// ---------------------------------------------------------------------------
// Preflight READ-ONLY — ZERO CLAIM OBRIGATÓRIO. Nenhuma mutação, nenhum
// evento, nenhuma carga de token, nenhuma rede. Reconstrói o item
// EXCLUSIVAMENTE do evento CAMPANHA_CANARIO_SELECIONADO persistido; falha ⇒
// bloqueios sanitizados e nenhuma interação com o caminho de execução.
// ---------------------------------------------------------------------------
export interface EntradaPreflightCanario {
  readonly operatorId: string;
  readonly campanhaId: string;
  readonly politica: PfUpdateCampaignPolicy;
  readonly contexto: {
    readonly chaveProva?: Buffer;
    readonly fingerprinter?: HmacSha256Fingerprinter;
  };
}

export type ResultadoPreflightCanario =
  | {
      readonly elegivel: true;
      readonly loteCampanhaId: string;
      readonly itemId: string;
      readonly destinatario: DestinatarioResolvidoCanario;
      readonly provas: ProvasAutorizacaoExecucao;
      readonly chaveIdempotencia: string;
      readonly fingerprintConfigurado: string;
    }
  | { readonly elegivel: false; readonly bloqueios: readonly string[] };

export async function preflightCanarioCampanha(
  pool: CampanhaPool,
  entrada: EntradaPreflightCanario,
): Promise<ResultadoPreflightCanario> {
  const bloqueios: string[] = [];
  const { politica } = entrada;

  // 1. Armamento (autoridade única: política). Necessário, NUNCA suficiente.
  if (!politica.canarySendEnabled) bloqueios.push("CANARY_SEND_DISABLED");
  if (!politica.canExecute) bloqueios.push("CAMPAIGN_EXECUTE_DISABLED");
  if (!politica.realSendEnabled) bloqueios.push("REAL_SEND_DISABLED");

  // 2. Chave de provas (as provas humanas exigem a chave dedicada).
  const chaveProva = lerConfiguracaoChaveProvaCampanha();
  if (!chaveProva.proofKeyReady) bloqueios.push("PROOF_KEY_UNAVAILABLE");

  // 3. Configuração do canário server-side.
  const canario = lerConfiguracaoCanarioCampanha();
  if (!canario.canaryRecipientConfigured || !canario.fingerprint) {
    bloqueios.push("CANARY_RECIPIENT_NOT_CONFIGURED");
  }

  // 4. Reconstrução do canário EXCLUSIVAMENTE do evento persistido (leitura).
  const eventos = await pool.query(
    `SELECT e.id, e.sequencia, e.metadados
       FROM evento_auditoria e
       JOIN lote_campanha l ON l.id = e.agregado_id
       JOIN campanha_persistida c ON c.id = l.campanha_id
      WHERE e.agregado_tipo = 'CAMPANHA_EXECUCAO'
        AND c.id = $1 AND c.operator_id = $2
        AND e.tipo = $3
      ORDER BY e.sequencia DESC
      LIMIT 1`,
    [entrada.campanhaId, entrada.operatorId, CODIGO_EVENTO_CANARIO],
  );
  const eventoCanario = eventos.rows[0] as
    | { id: string; sequencia: string | number; metadados: { item_id?: unknown; ordem?: unknown } }
    | undefined;
  let itemId: string | null = null;
  if (!eventoCanario) {
    bloqueios.push("CANARIO_AUSENTE");
  } else {
    const itemIdEvento = eventoCanario.metadados?.item_id;
    itemId = typeof itemIdEvento === "string" && itemIdEvento ? itemIdEvento : null;
    if (!itemId) bloqueios.push("CANARIO_EVENTO_INCONSISTENTE");
  }

  // 5. Estado lote/item (leitura) — ownership server-side, lote ATIVO,
  //    evento de ATIVAÇÃO do MESMO lote, item PREPARADO.
  let loteCampanhaId: string | null = null;
  if (itemId) {
    const estado = await pool.query(
      `SELECT l.id AS lote_id, l.estado AS lote_estado, i.estado AS item_estado
         FROM outbox_campanha i
         JOIN lote_campanha l ON l.id = i.lote_campanha_id
         JOIN campanha_persistida c ON c.id = l.campanha_id
        WHERE i.id = $1 AND c.id = $2 AND c.operator_id = $3`,
      [itemId, entrada.campanhaId, entrada.operatorId],
    );
    const linha = estado.rows[0] as
      | { lote_id: string; lote_estado: string; item_estado: string }
      | undefined;
    if (!linha) {
      bloqueios.push("CANARIO_ITEM_INEXISTENTE");
    } else {
      loteCampanhaId = linha.lote_id;
      if (linha.lote_estado !== "ATIVO") bloqueios.push("LOTE_NAO_ATIVO");
      if (linha.item_estado !== "PREPARADO") bloqueios.push("ITEM_NAO_PREPARADO");
      // O evento de ativação deve pertencer ao MESMO lote reconstruído.
      const ativacao = await pool.query(
        `SELECT 1 AS ok FROM evento_auditoria
          WHERE agregado_tipo = 'CAMPANHA_EXECUCAO'
            AND agregado_id = $1 AND tipo = $2
          LIMIT 1`,
        [linha.lote_id, CODIGO_EVENTO_ATIVACAO],
      );
      if (!ativacao.rows[0]) bloqueios.push("ATIVACAO_AUSENTE");
    }
  }

  // 6. Provas server-side (read-only) — recipient proof + autorização humana.
  let provas: ProvasAutorizacaoExecucao | null = null;
  if (itemId && loteCampanhaId && chaveProva.proofKeyReady) {
    const resultadoProvas = await emitirProvasServerSideCampanha(
      pool,
      {
        operatorId: entrada.operatorId,
        campanhaId: entrada.campanhaId,
        loteCampanhaId,
        itemId,
      },
      { ...(chaveProva.chave ? { chaveProva: chaveProva.chave } : {}) },
    );
    if (!resultadoProvas) {
      bloqueios.push("PROVAS_INDISPONIVEIS");
    } else {
      provas = resultadoProvas.provas;
      if (!resultadoProvas.provas.recipientProofVerified) bloqueios.push("PROVA_DESTINATARIO_AUSENTE");
      if (!resultadoProvas.provas.humanAuthorizationVerified) bloqueios.push("AUTORIZACAO_HUMANA_AUSENTE");
    }
  }

  // 7. OAuth persistido (somente leitura de metadados; ZERO token).
  const oauth = await avaliarReadinessOauthCanario(pool, entrada.contexto.fingerprinter);
  if (!oauth.oauthConfigurationReady) bloqueios.push("OAUTH_CONFIGURATION_REQUIRED");
  if (!oauth.oauthConnectionStored) bloqueios.push("OAUTH_NOT_CONNECTED");
  if (!oauth.oauthExpectedAccountConfigured) bloqueios.push("OAUTH_EXPECTED_ACCOUNT_MISSING");
  if (!oauth.oauthStoredAccountMatchesExpected) bloqueios.push("OAUTH_ACCOUNT_MISMATCH");
  if (!oauth.oauthEncryptionConfigurationReady) bloqueios.push("OAUTH_ENCRYPTION_KEY_MISSING");

  // 8. Provider wiring (identidade institucional derivável; sem rede).
  if (!provedorWiringReady()) bloqueios.push("PROVIDER_WIRING_NOT_READY");

  if (bloqueios.length > 0 || !itemId || !loteCampanhaId || !provas || !canario.fingerprint) {
    return { elegivel: false, bloqueios };
  }

  // 9. Resolução canônica do destinatário (snapshot congelado) + dupla prova
  //    de fingerprint + triplo match com a configuração do canário.
  const resolucao = await resolverDestinatarioCanario(pool, {
    operatorId: entrada.operatorId,
    campanhaId: entrada.campanhaId,
    loteCampanhaId,
    itemId,
  });
  if (!isDestinatarioResolvido(resolucao)) {
    bloqueios.push(resolucao);
    return { elegivel: false, bloqueios };
  }
  if (resolucao.fingerprintRecalculado !== resolucao.fingerprintOutbox) {
    bloqueios.push("FINGERPRINT_DIVERGENTE");
    return { elegivel: false, bloqueios };
  }
  if (resolucao.fingerprintRecalculado !== canario.fingerprint) {
    bloqueios.push("CANARY_FINGERPRINT_MISMATCH");
    return { elegivel: false, bloqueios };
  }

  const chaveIdempotencia = chaveIdempotenciaExecucao({
    campanhaId: entrada.campanhaId,
    loteCampanhaId,
    itemId,
    destinatarioFingerprint: resolucao.fingerprintOutbox,
    hashAprovacao: resolucao.hashAprovacao,
  });

  return {
    elegivel: true,
    loteCampanhaId,
    itemId,
    destinatario: resolucao,
    provas,
    chaveIdempotencia,
    fingerprintConfigurado: canario.fingerprint,
  };
}

// ---------------------------------------------------------------------------
// OAuth readiness — ESTRITAMENTE READ-ONLY.
//   · nenhuma rede (nenhum Google, nenhum fetch);
//   · nenhum token carregado/descriptografado;
//   · nenhum refresh;
//   · CONNECTED = configuração completa ∧ conexão persistida ativa ∧ conta
//     persistida igual à esperada (comparação por FINGERPRINT persistido ×
//     derivado da conta esperada configurada) — NÃO significa token testado
//     ao vivo, refresh bem-sucedido, Gmail alcançável ou alias validado.
// ---------------------------------------------------------------------------
export interface ReadinessOauthCanario {
  readonly oauthConfigurationReady: boolean;
  readonly oauthConnectionStored: boolean;
  readonly oauthExpectedAccountConfigured: boolean;
  readonly oauthStoredAccountMatchesExpected: boolean;
  readonly oauthEncryptionConfigurationReady: boolean;
  /** Derivado dos campos acima — nunca de rede nem de token ao vivo. */
  readonly executionReady: boolean;
}

export async function avaliarReadinessOauthCanario(
  pool: Pick<CampanhaPool, "query">,
  fingerprinter?: HmacSha256Fingerprinter,
  env: AmbienteLeve = process.env,
): Promise<ReadinessOauthCanario> {
  const oauthConfigurationReady = loadGmailOauthConfig(env) !== undefined;
  const esperado = env.GMAIL_EXPECTED_ACCOUNT?.trim().toLowerCase() ?? "";
  const oauthExpectedAccountConfigured = esperado.length > 0;
  const oauthEncryptionConfigurationReady =
    (env.DATA_ENCRYPTION_KEY_BASE64?.trim() ?? "").length > 0;
  let oauthConnectionStored = false;
  let oauthStoredAccountMatchesExpected = false;
  if (oauthConfigurationReady && oauthExpectedAccountConfigured && fingerprinter) {
    const fingerprintEsperado = derivarFingerprintContaGmail(fingerprinter, esperado);
    const linhas = await pool.query(
      `SELECT conta_fingerprint FROM oauth_connection
        WHERE provider = 'GMAIL' AND revogada_em IS NULL
        ORDER BY criada_em DESC
        LIMIT 1`,
    );
    const linha = linhas.rows[0] as { conta_fingerprint: string } | undefined;
    if (linha) {
      oauthConnectionStored = true;
      oauthStoredAccountMatchesExpected = linha.conta_fingerprint === fingerprintEsperado;
    }
  }
  return {
    oauthConfigurationReady,
    oauthConnectionStored,
    oauthExpectedAccountConfigured,
    oauthStoredAccountMatchesExpected,
    oauthEncryptionConfigurationReady,
    executionReady:
      oauthConfigurationReady &&
      oauthConnectionStored &&
      oauthExpectedAccountConfigured &&
      oauthStoredAccountMatchesExpected &&
      oauthEncryptionConfigurationReady,
  };
}

/**
 * Derivação CANÔNICA do estado sanitizado a partir do readiness — consumida
 * pela rota de readiness (mesma função no gate do canário). CONNECTED significa
 * EXCLUSIVAMENTE "config OAuth presente ∧ conexão persistida ativa ∧ conta
 * persistida correspondente à esperada". NÃO prova: ACCESS_TOKEN_VALID,
 * REFRESH_TOKEN_VALID, GMAIL_API_REACHABLE ou SEND_AS_ALLOWED (03C.2B1).
 */
export function statusOauthFromReadiness(
  readiness: ReadinessOauthCanario,
): "CONFIGURATION_REQUIRED" | "NOT_CONNECTED" | "CONNECTED" {
  if (!readiness.oauthConfigurationReady) return "CONFIGURATION_REQUIRED";
  return readiness.oauthConnectionStored &&
    readiness.oauthExpectedAccountConfigured &&
    readiness.oauthStoredAccountMatchesExpected
    ? "CONNECTED"
    : "NOT_CONNECTED";
}

/** Estado sanitizado para a UI (mesma semântica read-only). */
export async function statusOauthCanario(
  pool: Pick<CampanhaPool, "query">,
  fingerprinter?: HmacSha256Fingerprinter,
  env: AmbienteLeve = process.env,
): Promise<"CONFIGURATION_REQUIRED" | "NOT_CONNECTED" | "CONNECTED"> {
  const readiness = await avaliarReadinessOauthCanario(pool, fingerprinter, env);
  return statusOauthFromReadiness(readiness);
}

// ---------------------------------------------------------------------------
// Identidade de remetente da CAMPANHA — neutra/injetada server-side, SEM
// dependência semântica do piloto. Derivada do endereço institucional já
// homologado (carteiras@crtba.org.br); display name preservado; nada é
// escolhido pelo browser. O Message-ID da campanha usa o domínio derivado
// DESTE endereço (nunca o domínio hardcoded do piloto).
// ---------------------------------------------------------------------------
export function derivarRemetenteCampanha(env: AmbienteLeve = process.env): {
  name: string;
  address: string;
  dominio: string;
} | null {
  const address = (env.CAMPAIGN_SENDER_ADDRESS ?? "carteiras@crtba.org.br").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(address)) return null;
  const name = (env.CAMPAIGN_SENDER_NAME ?? "CRT-BA | Carteiras Profissionais").trim();
  if (!name) return null;
  const dominio = address.split("@")[1]!;
  return { name, address, dominio };
}

/** Provider wiring ready = identidade institucional derivável (sem rede). */
export function provedorWiringReady(env: AmbienteLeve = process.env): boolean {
  return derivarRemetenteCampanha(env) !== null;
}

// ---------------------------------------------------------------------------
// ProvedorGmailCampanha — implementação runtime do ProvedorEnvioCampanha.
// Revalida o fingerprint do comando contra o snapshot congelado (defesa em
// profundidade; NÃO substitui o preflight). Zero rede quando transport/token
// não resolvidos: FALHA_PRE_PROVIDER é SEMPRE resultado, nunca exceção.
// ---------------------------------------------------------------------------
export interface DependenciasProvedorGmailCampanha {
  readonly pool: Pick<CampanhaPool, "query">;
  readonly campanhaId: string;
  /** GmailMailGateway construído com transport/loadAccessToken injetados. */
  readonly gateway: GmailMailGateway;
  /** Ambiente NÃO lido pelo provider: apenas derivação do remetente. */
  readonly env?: AmbienteLeve;
}

/**
 * GF-2 FINAL — projeção dos campos de exibição do payload/snapshot para a
 * entrada do renderer: renormalização de APRESENTAÇÃO (whitespace sequencial
 * → espaço único; trim; vazio ⇒ ausente) com confinamento de tipo. NUNCA
 * completa, infere ou converte valores; NUNCA inclui CPF (fora do contrato).
 */
function payloadExibicaoCampanha(entrada: unknown): RenderInputCampanha["exibicao"] | undefined {
  if (entrada === undefined || entrada === null) return undefined;
  if (typeof entrada !== "object" || Array.isArray(entrada)) return undefined;
  const bruto = entrada as Record<string, unknown>;
  const campo = (chave: string): string | undefined =>
    typeof bruto[chave] === "string" ? campoExibicao(bruto[chave] as string) : undefined;
  const projetado = {
    ...(campo("logradouro") === undefined ? {} : { logradouro: campo("logradouro") }),
    ...(campo("numero") === undefined ? {} : { numero: campo("numero") }),
    ...(campo("complemento") === undefined ? {} : { complemento: campo("complemento") }),
    ...(campo("bairro") === undefined ? {} : { bairro: campo("bairro") }),
    ...(campo("cidade") === undefined ? {} : { cidade: campo("cidade") }),
    ...(campo("uf") === undefined ? {} : { uf: campo("uf") }),
    ...(campo("cep") === undefined ? {} : { cep: campo("cep") }),
    ...(campo("telefone") === undefined ? {} : { telefone: campo("telefone") }),
  };
  if (Object.keys(projetado).length === 0) {
    return entrada !== undefined && typeof entrada === "object" ? {} : undefined;
  }
  return projetado as RenderInputCampanha["exibicao"];
}

export class ProvedorGmailCampanha implements ProvedorEnvioCampanha {
  readonly nome = "GMAIL_CAMPANHA";
  private _chamadas = 0;

  constructor(private readonly dependencias: DependenciasProvedorGmailCampanha) {}

  get numeroChamadas(): number {
    return this._chamadas;
  }

  async enviar(comando: ComandoEnvioCampanha): Promise<ResultadoProvedorCampanha> {
    this._chamadas += 1;
    const remetente = derivarRemetenteCampanha(this.dependencias.env);
    if (!remetente) {
      return { tipo: "FALHA_PRE_PROVIDER", motivo: "CAMPANHA_SENDER_UNAVAILABLE" };
    }
    // Defesa em profundidade: revalidação pelo snapshot congelado (leitura).
    const linhas = await this.dependencias.pool.query(
      `SELECT i.ordem, i.destinatario_fingerprint, i.estado, l.template_versao, s.hash_aprovacao, s.snapshot_registros
         FROM outbox_campanha i
         JOIN lote_campanha l ON l.id = i.lote_campanha_id
         JOIN campanha_persistida s ON s.id = l.campanha_id
        WHERE i.id = $1`,
      [comando.itemId],
    );
    const linha = linhas.rows[0] as
      | {
          ordem: number;
          destinatario_fingerprint: string;
          estado: string;
          template_versao?: unknown;
          hash_aprovacao?: unknown;
          snapshot_registros: {
            registros?: readonly {
              email_normalizado?: unknown;
              nome?: unknown;
              profissional_id?: unknown;
              exibicao?: unknown;
            }[];
          };
        }
      | undefined;
    if (!linha) return { tipo: "FALHA_PRE_PROVIDER", motivo: "ITEM_INEXISTENTE" };
    if (linha.estado !== "ENFILEIRADO") {
      return { tipo: "FALHA_PRE_PROVIDER", motivo: "ITEM_NAO_ENFILEIRADO" };
    }
    const registro = (linha.snapshot_registros.registros ?? [])[Number(linha.ordem) - 1];
    const email = typeof registro?.email_normalizado === "string" ? registro.email_normalizado.trim() : "";
    const nome = typeof registro?.nome === "string" ? registro.nome.trim() : "";
    const profissionalId = typeof registro?.profissional_id === "string" ? registro.profissional_id.trim() : "";
    if (!email || !nome || !profissionalId) {
      return { tipo: "FALHA_PRE_PROVIDER", motivo: "SNAPSHOT_INCOMPATIVEL" };
    }
    // Campos de exibição (PREFILLED_CONFIRMATION) devem ser estruturais
    // (objeto) quando presentes; valores são renormalizados no registry.
    const exibicaoDoItem = payloadExibicaoCampanha(registro?.exibicao);
    if (registro?.exibicao !== undefined && exibicaoDoItem === undefined) {
      return { tipo: "FALHA_PRE_PROVIDER", motivo: "SNAPSHOT_CORROMPIDO" };
    }
    if (fingerprintDestinatarioCampanha(email) !== comando.destinatarioFingerprint) {
      return { tipo: "FALHA_PRE_PROVIDER", motivo: "FINGERPRINT_MISMATCH" };
    }

    // Render (server-side) — resolução pela versão CONGELADA no lote
    // (SLICE-03C.2B1D / GF-2 FINAL): o provider NUNCA aceita subject/corpos/
    // remetente, versão ou campos de exibição do request. Os campos de
    // exibição (PREFILLED_CONFIRMATION) vêm EXCLUSIVAMENTE do snapshot
    // congelado. DRAFT/RETIRED/desconhecida/incompatível/corrompida ⇒ falha
    // pré-provider sanitizada (defesa em profundidade; o preflight pré-claim
    // em campaign-execution.ts normalmente impede chegar aqui).
    let mensagem: OutboundMail;
    try {
      const renderizado = renderizarTemplatePersistido({
        persistedTemplateVersion: typeof linha.template_versao === "string" ? linha.template_versao : "",
        professionalName: nome,
        correlationCode: correlationCodeCanario({
          chaveIdempotencia: comando.chaveIdempotencia,
          itemId: comando.itemId,
        }),
        ...(exibicaoDoItem === undefined ? {} : { exibicao: exibicaoDoItem }),
        remetente: { name: remetente.name, address: remetente.address },
        campaignId: this.dependencias.campanhaId,
        itemId: comando.itemId,
        professionalId: profissionalId,
        recipient: email,
        messageTag: "pf-campanha",
      });
      if (!renderizado.ok) {
        return {
          tipo: "FALHA_PRE_PROVIDER",
          motivo: motivoFalhaTemplateCampanha(renderizado.code),
        };
      }
      mensagem = renderizado.mensagem;
    } catch {
      return { tipo: "FALHA_PRE_PROVIDER", motivo: "RENDER_INDISPONIVEL" };
    }

    // GF-2 FINAL — defesa em profundidade: o hash de aprovação (que congela
    // a versão + o contentHash canônico via snapshot JSONB) deve estar
    // íntegro ANTES de qualquer gateway (o preflight PRÉ-claim é a autoridade
    // primária; aqui a verificação é repetida imediatamente antes do envio).
    if (typeof linha.hash_aprovacao !== "string" || linha.hash_aprovacao.length !== 64) {
      return { tipo: "FALHA_PRE_PROVIDER", motivo: "SNAPSHOT_CORROMPIDO" };
    }
    try {
      const receipt: MailReceipt = await this.dependencias.gateway.send(mensagem);
      if (!receipt?.messageId) {
        return { tipo: "FALHA_DEFINITIVA", motivo: "RECEIPT_SEM_MESSAGE_ID" };
      }
      return {
        tipo: "ENVIADO",
        receipt: {
          provider: this.nome,
          messageId: receipt.messageId,
          acceptedAt: receipt.acceptedAt,
          chaveIdempotencia: comando.chaveIdempotencia,
        },
      };
    } catch (error) {
      // SLICE-03C.2A.1 — matriz normativa de classificação. AUTO_RETRY é
      // SEMPRE false neste slice (o canário proíbe segunda tentativa
      // automática); AMBIGUO ⇒ reconciliação HUMANA.
      // SLICE-03C.2B1A — resolução de token (config/conexão/decrypt/refresh)
      // falhou ANTES de qualquer messages.send: SEMPRE FALHA_PRE_PROVIDER.
      // Nunca AMBIGUO (nada foi despachado) e nunca rejeição de envio.
      if (error instanceof CampanhaTokenResolutionError) {
        return { tipo: "FALHA_PRE_PROVIDER", motivo: "TOKEN_RESOLUTION_INDISPONIVEL" };
      }
      if (error instanceof GmailAmbiguousError) {
        return { tipo: "AMBIGUO", motivo: "GMAIL_AMBIGUO" };
      }
      if (error instanceof MailProviderNaoConfiguradoError) {
        return { tipo: "FALHA_PRE_PROVIDER", motivo: "PROVIDER_INDISPONIVEL" };
      }
      if (error instanceof GmailAuthError) {
        // 401: rejeição CONCLUSIVA por autenticação (houve Response).
        return { tipo: "FALHA_DEFINITIVA", motivo: "AUTH_REQUIRED" };
      }
      if (error instanceof GmailRateLimitError) {
        // 429 / 403 rateLimitExceeded: resposta CONCLUSIVA do Gmail — porém
        // rate-limit NÃO é erro permanente. Terminaliza ESTA tentativa sem
        // novo send (FALHA_DEFINITIVA é apenas o estado terminal do contrato
        // atual); motivo preserva RATE_LIMITED; AUTO_RETRY=false.
        return { tipo: "FALHA_DEFINITIVA", motivo: "RATE_LIMITED" };
      }
      if (error instanceof GmailPermanentPolicyError) {
        return { tipo: "FALHA_DEFINITIVA", motivo: "PERMANENT_POLICY" };
      }
      if (error instanceof MailProviderRequestError) {
        // HTTP conclusivo fora das classes acima (ex.: 400 com Response).
        return { tipo: "FALHA_DEFINITIVA", motivo: "GMAIL_HTTP_REJEITADO" };
      }
      // Erro DESCONHECIDO ocorrido após possível despacho, sem prova
      // conclusiva de rejeição ⇒ INCERTO (nunca definitivo por herança).
      return { tipo: "AMBIGUO", motivo: "GMAIL_AMBIGUO" };
    }
  }
}

// ---------------------------------------------------------------------------
// Execução do canário — ÚNICA porta da rota. Preflight OBRIGATÓRIO primeiro;
// com zero bloqueios, executa o caminho 03A com o provider injetado. Os
// gatekeepings de política são reexercidos dentro de executeAttemptCampanha
// e a revalidação de fingerprint pelo provider é a terceira camada.
// ---------------------------------------------------------------------------
export type ResultadoCanarioSend =
  | { readonly tipo: "BLOQUEADO"; readonly bloqueios: readonly string[] }
  | { readonly tipo: "EXECUTADO"; readonly resultado: ResultadoTentativaExecucao };

export async function enviarCanarioCampanha(
  pool: CampanhaPool,
  entrada: {
    readonly operatorId: string;
    readonly campanhaId: string;
    readonly politica: PfUpdateCampaignPolicy;
    readonly provider: ProvedorEnvioCampanha;
    readonly contexto: {
      readonly chaveProva?: Buffer;
      readonly fingerprinter?: HmacSha256Fingerprinter;
    };
  },
): Promise<ResultadoCanarioSend> {
  const preflight = await preflightCanarioCampanha(pool, {
    operatorId: entrada.operatorId,
    campanhaId: entrada.campanhaId,
    politica: entrada.politica,
    contexto: entrada.contexto,
  });
  if (!preflight.elegivel) {
    return { tipo: "BLOQUEADO", bloqueios: preflight.bloqueios };
  }
  const comando: ComandoTentativaExecucao = {
    operatorId: entrada.operatorId,
    campanhaId: entrada.campanhaId,
    loteCampanhaId: preflight.loteCampanhaId,
    itemId: preflight.itemId,
    politica: entrada.politica,
    provas: preflight.provas,
    provider: entrada.provider,
  };
  const resultado = await executeAttemptCampanha(pool, comando);
  return { tipo: "EXECUTADO", resultado };
}
