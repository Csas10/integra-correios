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

  async sendEmail(state: PfWorkflowState): Promise<{ state: PfWorkflowState; token: string }> {
    const prepared = move(state, "EMAIL_ENVIADO", this.dependencies);
    const token = await this.dependencies.tokens.issue();
    const issuedAt = now(this.dependencies);
    const confirmationId = this.dependencies.idFactory?.() ?? crypto.randomUUID();
    const confirmation = {
      id: confirmationId,
      professionalId: prepared.professional.id,
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
      professionalId: prepared.professional.id,
      type: "PF_CONFIRMATION_ISSUED",
      occurredAt: issuedAt.toISOString(),
      metadata: { confirmationId },
    };
    const message = renderPfConfirmationMail({
      confirmationId,
      professionalId: prepared.professional.id,
      recipient: prepared.professional.original.email,
      professionalName: prepared.professional.original.nome,
      replyTo: "carteiras@instituicao.example",
      confirmationPath: `/confirma/${token.plainToken}`,
    });
    const receipt: MailReceipt = await this.dependencies.mail.send(message);
    const awaiting = move(prepared, "AGUARDANDO_CONFIRMACAO", this.dependencies);
    const communication = {
      id: this.dependencies.idFactory?.() ?? crypto.randomUUID(),
      professionalId: awaiting.professional.id,
      confirmationId,
      provider: receipt.provider,
      providerMessageId: receipt.messageId,
      templateVersion: message.templateVersion,
      sentAt: receipt.acceptedAt,
      status: "ACCEPTED" as const,
    };
    const communicationEvent: PfAuditEvent = {
      id: this.dependencies.auditIdFactory?.() ?? crypto.randomUUID(),
      professionalId: awaiting.professional.id,
      type: "PF_COMMUNICATION_ACCEPTED",
      occurredAt: receipt.acceptedAt,
      metadata: { provider: receipt.provider, messageId: receipt.messageId },
    };
    return {
      token: token.plainToken,
      state: {
        ...awaiting,
        confirmation,
        communication,
        audit: [...awaiting.audit, confirmationEvent, communicationEvent],
      },
    };
  }

  async submitConfirmation(
    state: PfWorkflowState,
    plainToken: string,
    submission: ConfirmationSubmission,
  ): Promise<PfWorkflowState> {
    const confirmation = state.confirmation;
    if (!confirmation) throw new Error("Confirmação inexistente");
    if (confirmation.status !== "PENDING") throw new Error("Token já utilizado");
    if (new Date(confirmation.expiresAt) <= now(this.dependencies)) throw new Error("Token expirado");
    if ((await this.dependencies.tokens.hash(plainToken)) !== confirmation.tokenHash) {
      throw new Error("Token inválido");
    }
    const snapshot = submission.decision === "CONFIRMAR" ? state.professional.original : submission.snapshot;
    if (!snapshot) throw new Error("Dados atualizados ausentes");
    const nextStatus = submission.decision === "CONFIRMAR" ? "CONFIRMADO_SEM_ALTERACAO" : "CONFIRMADO_COM_ALTERACAO";
    const moved = move(state, nextStatus, this.dependencies, { decision: submission.decision });
    return {
      ...moved,
      professional: { ...moved.professional, confirmed: structuredClone(snapshot) },
      confirmation: { ...confirmation, status: "SUBMITTED", usedAt: now(this.dependencies).toISOString() },
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
