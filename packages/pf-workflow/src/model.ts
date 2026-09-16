import { criarIdentidade, type IdentidadeOperacional } from "@integra-correios/domain";

export const PF_CONFIRMATION_STATUSES = [
  "CARTEIRA_IDENTIFICADA",
  "PENDENCIA_TRIAGEM",
  "APTO_CONTATO",
  "EMAIL_PENDENTE",
  "EMAIL_ENVIADO",
  "AGUARDANDO_CONFIRMACAO",
  "CONFIRMADO_SEM_ALTERACAO",
  "CONFIRMADO_COM_ALTERACAO",
  "EM_VALIDACAO",
  "PENDENCIA_CADASTRAL",
  "APTO_PREPOSTAGEM",
  "INCLUIDO_EM_LOTE",
  "POSTADO",
] as const;

export type PfConfirmationStatus = (typeof PF_CONFIRMATION_STATUSES)[number];

export const CONFIRMATION_DECISIONS = ["CONFIRMAR", "ATUALIZAR"] as const;
export type ConfirmationDecision = (typeof CONFIRMATION_DECISIONS)[number];

export interface PfAddress {
  readonly logradouro: string;
  readonly numero: string;
  readonly complemento?: string;
  readonly bairro: string;
  readonly cidade: string;
  readonly uf: string;
  readonly cep: string;
}

export interface PfCadastreSnapshot {
  readonly documento: string;
  readonly nome: string;
  readonly email: string;
  readonly telefone: string;
  readonly whatsapp?: string;
  readonly endereco: PfAddress;
}

export interface PfProfessional {
  readonly id: IdentidadeOperacional;
  readonly origem: "PF";
  readonly status: PfConfirmationStatus;
  readonly original: PfCadastreSnapshot;
  readonly confirmed?: PfCadastreSnapshot;
}

export interface ConfirmationRecord {
  readonly id: string;
  readonly professionalId: IdentidadeOperacional;
  readonly tokenHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly usedAt?: string;
  readonly status: "PENDING" | "SUBMITTED" | "EXPIRED";
  readonly templateVersion: string;
}

export interface CommunicationRecord {
  readonly id: string;
  readonly professionalId: IdentidadeOperacional;
  readonly confirmationId: string;
  readonly provider: string;
  readonly providerMessageId: string;
  readonly templateVersion: string;
  readonly sentAt: string;
  readonly status: "ACCEPTED" | "DELIVERED" | "BOUNCED" | "FAILED";
}

export interface PfAuditEvent {
  readonly id: string;
  readonly professionalId: IdentidadeOperacional;
  readonly type: "PF_STATUS_CHANGED" | "PF_CONFIRMATION_ISSUED" | "PF_COMMUNICATION_ACCEPTED";
  readonly occurredAt: string;
  readonly from?: PfConfirmationStatus;
  readonly to?: PfConfirmationStatus;
  readonly metadata: Readonly<Record<string, string | boolean>>;
}

export interface PfWorkflowState {
  readonly professional: PfProfessional;
  readonly confirmation?: ConfirmationRecord;
  readonly communication?: CommunicationRecord;
  readonly audit: readonly PfAuditEvent[];
}

export interface ConfirmationSubmission {
  readonly decision: ConfirmationDecision;
  readonly snapshot?: PfCadastreSnapshot;
}

export interface TokenPair {
  readonly plainToken: string;
  readonly tokenHash: string;
}

export interface TokenService {
  issue(): Promise<TokenPair>;
  hash(plainToken: string): Promise<string>;
}

export interface PfWorkflowDependencies {
  readonly mail: import("@integra-correios/mail").MailGateway;
  readonly confirmations: import("./ownership.js").ConfirmationOwnership;
  readonly tokens: TokenService;
  readonly confirmationBaseUrl: string;
  readonly confirmationReplyTo: string;
  readonly clock?: () => Date;
  readonly confirmationTtlMs?: number;
  readonly idFactory?: () => string;
  readonly auditIdFactory?: () => string;
}

export function criarProfissionalPf(
  codigo: string,
  original: PfCadastreSnapshot,
): PfProfessional {
  return {
    id: criarIdentidade("PF", codigo),
    origem: "PF",
    status: "CARTEIRA_IDENTIFICADA",
    original: structuredClone(original),
  };
}

export function podeIrParaPrePostagem(status: PfConfirmationStatus): boolean {
  return status === "APTO_PREPOSTAGEM";
}
