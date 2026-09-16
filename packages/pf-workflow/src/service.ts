import {
  renderPfConfirmationMail,
  type MailReceipt,
} from "@integra-correios/mail";
import type { PfConfirmationStatus } from "./model.js";
import {
  type ConfirmationSubmission,
  type PfAuditEvent,
  type PfWorkflowDependencies,
  type PfWorkflowState,
} from "./model.js";
import { validarTransicaoPf } from "./transitions.js";
import { validarCadastroPf } from "./validation.js";

function now(dependencies: PfWorkflowDependencies): Date {
  return dependencies.clock?.() ?? new Date();
}

function buildConfirmationUrl(baseUrl: string, plainToken: string): string {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password) {
    throw new Error("confirmationBaseUrl deve usar HTTPS e não conter credenciais");
  }
  return new URL(`/confirma/${encodeURIComponent(plainToken)}`, base).toString();
}

function move(
  state: PfWorkflowState,
  to: PfConfirmationStatus,
  dependencies: PfWorkflowDependencies,
  metadata: Readonly<Record<string, string | boolean>> = {},
): PfWorkflowState {
  const from = state.professional.status;
  validarTransicaoPf(from, to);
  const occurredAt = now(dependencies).toISOString();
  const event: PfAuditEvent = {
    id: dependencies.auditIdFactory?.() ?? crypto.randomUUID(),
    professionalId: state.professional.id,
    type: "PF_STATUS_CHANGED",
    occurredAt,
    from,
    to,
    metadata,
  };
  return {
    ...state,
    professional: { ...state.professional, status: to },
    audit: [...state.audit, event],
  };
}

export class PfConfirmationWorkflow {
  constructor(private readonly dependencies: PfWorkflowDependencies) {}

  triage(state: PfWorkflowState, apto: boolean): PfWorkflowState {
    return move(state, apto ? "APTO_CONTATO" : "PENDENCIA_TRIAGEM", this.dependencies, {
      reason: apto ? "triagem_aprovada" : "triagem_pendente",
    });
  }

  prepareEmail(state: PfWorkflowState): PfWorkflowState {
    return move(state, "EMAIL_PENDENTE", this.dependencies);
  }

  async sendEmail(state: PfWorkflowState): Promise<PfWorkflowState> {
    const token = await this.dependencies.tokens.issue();
    const issuedAt = now(this.dependencies);
    const confirmationId = this.dependencies.idFactory?.() ?? crypto.randomUUID();
    const confirmation = {
      id: confirmationId,
      professionalId: state.professional.id,
      tokenHash: token.tokenHash,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(
        issuedAt.getTime() + (this.dependencies.confirmationTtlMs ?? 7 * 24 * 60 * 60 * 1000),
      ).toISOString(),
      status: "PENDING" as const,
      templateVersion: "pf-confirmation-v1",
    };
    const confirmationEvent: PfAuditEvent = {
      id: this.dependencies.auditIdFactory?.() ?? crypto.randomUUID(),
      professionalId: state.professional.id,
      type: "PF_CONFIRMATION_ISSUED",
      occurredAt: issuedAt.toISOString(),
      metadata: { confirmationId },
    };
    const issued: PfWorkflowState = {
      ...state,
      confirmation,
      audit: [...state.audit, confirmationEvent],
    };
    const confirmationUrl = buildConfirmationUrl(
      this.dependencies.confirmationBaseUrl,
      token.plainToken,
    );
    const message = renderPfConfirmationMail({
      confirmationId,
      professionalId: state.professional.id,
      recipient: state.professional.original.email,
      professionalName: state.professional.original.nome,
      replyTo: this.dependencies.confirmationReplyTo,
      confirmationUrl,
    });
    const receipt: MailReceipt = await this.dependencies.mail.send(message);
    const sent = move(issued, "EMAIL_ENVIADO", this.dependencies);
    const communication = {
      id: this.dependencies.idFactory?.() ?? crypto.randomUUID(),
      professionalId: sent.professional.id,
      confirmationId,
      provider: receipt.provider,
      providerMessageId: receipt.messageId,
      templateVersion: message.templateVersion,
      sentAt: receipt.acceptedAt,
      status: "ACCEPTED" as const,
    };
    const communicationEvent: PfAuditEvent = {
      id: this.dependencies.auditIdFactory?.() ?? crypto.randomUUID(),
      professionalId: sent.professional.id,
      type: "PF_COMMUNICATION_ACCEPTED",
      occurredAt: receipt.acceptedAt,
      metadata: { provider: receipt.provider, messageId: receipt.messageId },
    };
    const accepted: PfWorkflowState = {
      ...sent,
      communication,
      audit: [...sent.audit, communicationEvent],
    };
    const awaiting = move(accepted, "AGUARDANDO_CONFIRMACAO", this.dependencies);
    await this.dependencies.confirmations.registerPending(confirmation);
    return awaiting;
  }

  async submitConfirmation(
    state: PfWorkflowState,
    plainToken: string,
    submission: ConfirmationSubmission,
  ): Promise<PfWorkflowState> {
    const confirmation = state.confirmation;
    if (!confirmation) throw new Error("Confirmação inexistente");
    if (confirmation.status !== "PENDING") throw new Error("Token já utilizado");
    const consumedAt = now(this.dependencies);
    if (new Date(confirmation.expiresAt) <= consumedAt) throw new Error("Token expirado");
    const tokenHash = await this.dependencies.tokens.hash(plainToken);
    if (tokenHash !== confirmation.tokenHash) {
      throw new Error("Token inválido");
    }
    const snapshot = submission.decision === "CONFIRMAR" ? state.professional.original : submission.snapshot;
    if (!snapshot) throw new Error("Dados atualizados ausentes");
    const nextStatus = submission.decision === "CONFIRMAR" ? "CONFIRMADO_SEM_ALTERACAO" : "CONFIRMADO_COM_ALTERACAO";
    validarTransicaoPf(state.professional.status, nextStatus);
    const consumed = await this.dependencies.confirmations.consumePending({
      confirmationId: confirmation.id,
      tokenHash,
      usedAt: consumedAt.toISOString(),
    });
    if (!consumed) throw new Error("Token já utilizado ou expirado");
    const moved = move(state, nextStatus, this.dependencies, { decision: submission.decision });
    return {
      ...moved,
      professional: { ...moved.professional, confirmed: structuredClone(snapshot) },
      confirmation: consumed,
    };
  }

  validateForPrePostagem(state: PfWorkflowState): PfWorkflowState {
    if (!state.professional.confirmed) throw new Error("Confirmação cadastral ausente");
    const validating = move(state, "EM_VALIDACAO", this.dependencies);
    const result = validarCadastroPf(state.professional.confirmed);
    return move(validating, result.valid ? "APTO_PREPOSTAGEM" : "PENDENCIA_CADASTRAL", this.dependencies, {
      valid: result.valid,
      issues: result.issues.join(","),
    });
  }
}

export function assertAptoParaPrePostagem(state: PfWorkflowState): void {
  if (state.professional.status !== "APTO_PREPOSTAGEM") {
    throw new Error("PF só pode entrar em lote após APTO_PREPOSTAGEM");
  }
}
