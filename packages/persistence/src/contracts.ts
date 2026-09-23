import type { EncryptedValue } from "./crypto.js";

export interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface SqlExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface SqlTransaction extends SqlExecutor {
  release(): void;
}

export interface SqlPool extends SqlExecutor {
  connect(): Promise<SqlTransaction>;
}

export interface EncryptedDocument {
  readonly documentType: "CPF" | "CNPJ";
  readonly fingerprint: string;
  readonly encrypted: EncryptedValue;
}

export interface CreateProfessionalCommand {
  readonly id: string;
  readonly origin: "PF" | "PJ";
  readonly operationalCode: string;
  readonly status: string;
  readonly document: EncryptedDocument;
  readonly originalSnapshot: EncryptedValue;
  readonly auditEvent: AuditEventInput;
}

export interface AuditEventInput {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly type: string;
  readonly actorId?: string;
  readonly occurredAt: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
  readonly previousHash?: string;
  readonly eventHash: string;
}

/**
 * Modo conceitual do lote (F7): DRY_RUN usa gateway sintético; LIVE_PILOT é o
 * mesmo motor trocando apenas o adapter final. Persistido para que DRY_RUN
 * nunca possa virar LIVE silenciosamente e a auditoria seja inequívoca.
 */
export type BatchMode = "DRY_RUN" | "LIVE_PILOT";

export interface CommunicationBatchItem {
  readonly professionalId: string;
  readonly confirmationId: string;
  readonly communicationId: string;
  readonly outboxId: string;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly recipientFingerprint: string;
  readonly idempotencyKey: string;
  readonly encryptedPayload: EncryptedValue;
  readonly auditEvent: AuditEventInput;
}

export interface EnqueueCommunicationBatchCommand {
  readonly id: string;
  readonly code: string;
  readonly origin: "PF";
  readonly templateVersion: string;
  /** Modo de execução do lote — persistido em lote_comunicacao.modo (F7). */
  readonly mode: BatchMode;
  /** Origem do registro de cada comunicação (GATE 2, item 2 do closure). */
  readonly source: CommunicationSource;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly auditEvent: AuditEventInput;
  readonly items: readonly CommunicationBatchItem[];
}

export interface ActivateCommunicationBatchCommand {
  readonly batchId: string;
  readonly origin: "PF";
  readonly actorId: string;
  readonly activatedAt: string;
  readonly auditEvent: AuditEventInput;
}

export interface BatchActivationState {
  readonly status: "PREPARACAO" | "ATIVO" | "CONCLUIDO" | "CANCELADO";
  readonly totalItems: number;
  readonly sentItems: number;
  readonly templateVersion: string;
  readonly createdAt: string;
  readonly activatedAt: string | null;
  readonly resultCode:
    | "ACTIVATED"
    | "ALREADY_ACTIVE"
    | "INVALID_STATE"
    | "EMPTY"
    | "ALREADY_SENT";
}

/**
 * Cancelamento auditado de lote DRY_RUN histórico (isolamento operacional).
 * Fail-closed: somente o lote EXATO ATIVO/DRY_RUN pode ser cancelado, com
 * outbox totalmente resolvida e REAL_SEND_ENABLED=false no ambiente.
 */
export interface CancelCommunicationBatchCommand {
  readonly batchId: string;
  readonly origin: "PF";
  /** Código canônico exigido — rejeita qualquer outro lote. */
  readonly expectedCode: string;
  /** REAL_SEND_ENABLED lido do ambiente pelo chamador (nunca do request). */
  readonly realSendEnabled: boolean;
  readonly actorId: string;
  readonly cancelledAt: string;
  /** Motivo auditado fixo: HISTORICAL_DRY_RUN_ISOLATION. */
  readonly auditEvent: AuditEventInput;
}

/**
 * OUTBOX_GATE_CHAIN_FIX — recuperação auditada EXCLUSIVA do incidente
 * CONTROLLED_GATE_OAUTH_NOT_READY (bloqueio de gate comprovadamente pré-
 * messages.send). Devolve o outbox a PENDING na mesma transação do evento
 * de auditoria; nenhuma outra falha é recuperável por este mecanismo.
 */
export interface RecoverControlledOutboxCommand {
  readonly expectedCode: string;
  /** Código de erro exigido: CONTROLLED_GATE_OAUTH_NOT_READY. */
  readonly expectedErrorCode: string;
  /** Tentativas exigidas (2: PROVIDER_NOT_CONFIGURED + gate OAuth). */
  readonly expectedAttempts: number;
  /**
   * CORRECTIVE_LEGACY_INCIDENT_BINDING — vínculo obrigatório SOMENTE para a
   * classificação legada FAILED_PERMANENT: a recuperação é recusada se a
   * outbox não pertencer a esta comunicação EXATA (definida server-side;
   * nunca recebida do navegador) e exige o evento prévio
   * PF_CONTROLLED_RETRY_AUTORIZADO do lote. O fluxo específico
   * CONTROLLED_GATE_OAUTH_NOT_READY segue sem este vínculo.
   */
  readonly expectedCommunicationId?: string;
  /** REAL_SEND_ENABLED lido do ambiente pelo chamador (nunca do request). */
  readonly realSendEnabled: boolean;
  readonly availableAt: string;
  readonly auditEvent: AuditEventInput;
}

export interface BatchCancellationState {
  readonly status: "PREPARACAO" | "ATIVO" | "CONCLUIDO" | "CANCELADO";
  readonly totalItems: number;
  readonly templateVersion: string;
  readonly createdAt: string;
  readonly resultCode:
    | "CANCELLED"
    | "ALREADY_CANCELLED"
    | "NOT_HISTORICAL_BATCH"
    | "INVALID_STATE"
    | "MODE_NOT_DRY_RUN"
    | "OUTBOX_NOT_SETTLED";
}

/**
 * FINAL CLOSURE GATE item 2 — origem persistida do registro da comunicação:
 *  - CONTROLADO_SINTETICO: registro sintético do modo controlado;
 *  - INSTITUCIONAL_XLSX: proveniente do upload do XLSX institucional.
 * backfill 0006 → linhas pré-existentes = INSTITUCIONAL_XLSX (conservador).
 */
export type CommunicationSource = "CONTROLADO_SINTETICO" | "INSTITUCIONAL_XLSX";

export interface ClaimedOutboxItem {
  readonly id: string;
  readonly communicationId: string;
  readonly idempotencyKey: string;
  readonly encryptedPayload: EncryptedValue;
  readonly attempts: number;
  /** Modo do lote de origem (F7): inequívoco também na memória do worker. */
  readonly modo: BatchMode;
  /** Origem do registro (GATE 2): sintético controlado vs XLSX institucional. */
  readonly fonte: CommunicationSource;
}

export interface StoredOauthConnection {
  readonly id: string;
  readonly provider: "GMAIL";
  readonly accountFingerprint: string;
  readonly scopes: readonly string[];
  readonly accessToken: EncryptedValue;
  readonly refreshToken?: EncryptedValue;
  readonly expiresAt?: string;
}

export interface SaveOauthConnectionCommand {
  readonly connection: StoredOauthConnection;
  readonly auditEvent: AuditEventInput;
}

export interface AcceptOutboxCommand {
  readonly outboxId: string;
  readonly communicationId: string;
  readonly provider: "GMAIL" | "RESEND" | "DRY_RUN";
  readonly providerMessageId: string;
  readonly providerThreadId?: string;
  readonly acceptedAt: string;
  readonly auditEvent: AuditEventInput;
}

export interface FailOutboxCommand {
  readonly outboxId: string;
  readonly communicationId: string;
  readonly errorCode: string;
  readonly retryAt: string;
  readonly auditEvent: AuditEventInput;
}

export interface GmailOauthCredentialSource {
  loadGmailConnection(accountFingerprint: string): Promise<StoredOauthConnection | undefined>;
}

// ===========================================================================
// F18 — Binding one-time do fluxo OAuth persistido em PostgreSQL
// (serverless-safe): START em uma instância, CALLBACK em outra. O nonce
// BRUTO nunca é persistido — apenas seu SHA-256; o consumo é atômico
// (UPDATE ... RETURNING vence exatamente uma vez sob corrida).
// ===========================================================================

export interface RegisterOauthFlowBindingCommand {
  /** SHA-256 hex do nonce de binding (o nonce em claro NUNCA é persistido). */
  readonly nonceHash: string;
  /** Envelope AES-256-GCM do code_verifier PKCE: o valor em claro NUNCA é
   * persistido nem transportado pelo state/browser (FINAL CLOSURE GATE item
   * 1) — o callback autenticado recupera-o do banco para a troca do código. */
  readonly codeVerifier: EncryptedValue;
  /** SHA-256 hex da identidade do operador do START (derivada server-side do
   * OPERATOR_TOKEN): callback de sessão divergente é rejeitado. */
  readonly operadorHash: string;
  readonly expiresAt: string;
}

export interface ConsumeOauthFlowBindingCommand {
  readonly nonceHash: string;
  /** SHA-256 hex da identidade do operador do callback — deve ser idêntica
   * à do START, sob pena de SESSION_MISMATCH. */
  readonly operadorHash: string;
  readonly now: string;
}

/** Status do consumo atômico do binding one-time. */
export type OauthFlowBindingConsumeStatus =
  | "CONSUMED"
  | "MISSING"
  | "EXPIRED"
  | "REPLAY"
  | "SESSION_MISMATCH";

/** Resultado do consumo: em CONSUMED devolve o envelope cifrado do verifier. */
export interface OauthFlowBindingConsumeResult {
  readonly status: OauthFlowBindingConsumeStatus;
  readonly codeVerifierSealed?: EncryptedValue;
}

/**
 * Atualização segura do access token renovado (F3): persiste o novo envelope
 * cifrado preservando refresh token, scopes e identidade da conexão.
 */
export interface RefreshedOauthTokenCommand {
  readonly connectionId: string;
  readonly accountFingerprint: string;
  readonly accessToken: EncryptedValue;
  readonly expiresAt: string;
}

/**
 * FINAL CLOSURE GATE item 2 — comando da verificação do GATE 2 (modo
 * controlado): executada IMEDIATAMENTE antes de users.messages.send,
 * no caminho LIVE. Estado do lote (ATIVO, exatamente 1 item), liberação
 * humana auditada e receipt anterior são DERIVADOS NO BANCO; fonte,
 * destinatário e OAuth chegam do caminho de execução.
 */
export interface GmailControlledSendCommand {
  /** Fonte declarada do registro (sintético vs XLSX institucional). */
  readonly fonte: CommunicationSource;
  /** Comunicação a enviar (id). */
  readonly communicationId: string;
  /** Destinatário em claro da mensagem a enviar (RFC 5322). */
  readonly destinatario: string;
  /** OAuth da conta esperada está pronto (config + conexão). */
  readonly oauthPronto: boolean;
}

// ===========================================================================
// F5 — Backend público por capability token: consumo atômico do token
// (compare-and-set já existente) + fechamento operacional do workflow PF.
// Nenhum comando aqui aceita decisão/estado vindos do browser além do
// contrato explícito; replay/expiração falham fechados (consumePending).
// ===========================================================================

/** Contexto mínimo da página de confirmação — NUNCA documento/código/id interno. */
export interface ConfirmationContext {
  readonly nome: string;
  readonly enderecoApresentado: string;
  readonly telefoneMascarado: string;
  readonly expiraEm: string;
}

/** Dados propostos pelo profissional em ATUALIZAR (formulário público). */
export interface ProposedPfData {
  readonly logradouro: string;
  readonly numero: string;
  readonly complemento?: string;
  readonly bairro: string;
  readonly cidade: string;
  readonly uf: string;
  readonly cep: string;
  readonly telefone: string;
  readonly whatsapp?: string;
}

export interface RegisterConfirmationOutcomeCommand {
  /** ID da confirmação consumida por compare-and-set (consumePending). */
  readonly confirmationId: string;
  readonly professionalId: string;
  /** Snapshot decidido (proposto em ATUALIZAR / confirmado em CONFIRMAR), já CIFRADO pelo chamador. */
  readonly snapshotCifrado: EncryptedValue;
  /** Conteúdo em claro do snapshot decidido — apenas para regras server-side de elegibilidade. */
  readonly snapshotDecidido: Record<string, unknown>;
  readonly decisao: "CONFIRMAR" | "ATUALIZAR";
  readonly fonte: "CONFIRMACAO_WEB";
  readonly occurredAt: string;
}

export interface ConfirmationOutcomeResult {
  readonly confirmationId: string;
  readonly professionalId: string;
  /** Estado final do profissional após o fechamento server-side do workflow. */
  readonly status: "APTO_PREPOSTAGEM" | "PENDENCIA_CADASTRAL";
  readonly snapshotId: string;
}
