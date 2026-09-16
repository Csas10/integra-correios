import type { ConfirmationRecord } from "./model.js";

export interface ConsumePendingConfirmation {
  readonly confirmationId: string;
  readonly tokenHash: string;
  readonly usedAt: string;
}

export interface ConfirmationOwnership {
  registerPending(confirmation: ConfirmationRecord): Promise<void>;
  consumePending(command: ConsumePendingConfirmation): Promise<ConfirmationRecord | undefined>;
}

/**
 * Adapter de prova para um único processo JavaScript.
 * PostgreSQL deverá implementar o mesmo contrato com compare-and-set transacional.
 */
export class InMemoryConfirmationOwnership implements ConfirmationOwnership {
  private readonly confirmations = new Map<string, ConfirmationRecord>();

  async registerPending(confirmation: ConfirmationRecord): Promise<void> {
    if (this.confirmations.has(confirmation.id)) {
      throw new Error("Confirmação já registrada");
    }
    this.confirmations.set(confirmation.id, structuredClone(confirmation));
  }

  async consumePending(
    command: ConsumePendingConfirmation,
  ): Promise<ConfirmationRecord | undefined> {
    const current = this.confirmations.get(command.confirmationId);
    if (
      !current ||
      current.status !== "PENDING" ||
      current.tokenHash !== command.tokenHash ||
      new Date(current.expiresAt).getTime() <= new Date(command.usedAt).getTime()
    ) {
      return undefined;
    }

    const consumed: ConfirmationRecord = {
      ...current,
      status: "SUBMITTED",
      usedAt: command.usedAt,
    };
    this.confirmations.set(command.confirmationId, consumed);
    return structuredClone(consumed);
  }
}
