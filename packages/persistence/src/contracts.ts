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

export interface ClaimedOutboxItem {
  readonly id: string;
  readonly communicationId: string;
  readonly idempotencyKey: string;
  readonly encryptedPayload: EncryptedValue;
  readonly attempts: number;
  /** Modo do lote de origem (F7): inequívoco também na memória do worker. */
  readonly modo: BatchMode;
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
