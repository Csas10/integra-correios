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
  readonly createdBy: string;
  readonly createdAt: string;
  readonly auditEvent: AuditEventInput;
  readonly items: readonly CommunicationBatchItem[];
}

export interface ClaimedOutboxItem {
  readonly id: string;
  readonly communicationId: string;
  readonly idempotencyKey: string;
  readonly encryptedPayload: EncryptedValue;
  readonly attempts: number;
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
  readonly provider: "GMAIL" | "RESEND";
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
