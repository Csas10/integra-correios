import type { PfConfirmationStatus } from "./model.js";

const TRANSITIONS: Record<PfConfirmationStatus, readonly PfConfirmationStatus[]> = {
  CARTEIRA_IDENTIFICADA: ["APTO_CONTATO", "PENDENCIA_TRIAGEM"],
  PENDENCIA_TRIAGEM: ["APTO_CONTATO"],
  APTO_CONTATO: ["EMAIL_PENDENTE"],
  EMAIL_PENDENTE: ["EMAIL_ENVIADO", "PENDENCIA_CADASTRAL"],
  EMAIL_ENVIADO: ["AGUARDANDO_CONFIRMACAO"],
  AGUARDANDO_CONFIRMACAO: ["CONFIRMADO_SEM_ALTERACAO", "CONFIRMADO_COM_ALTERACAO", "PENDENCIA_CADASTRAL"],
  CONFIRMADO_SEM_ALTERACAO: ["EM_VALIDACAO"],
  CONFIRMADO_COM_ALTERACAO: ["EM_VALIDACAO"],
  EM_VALIDACAO: ["APTO_PREPOSTAGEM", "PENDENCIA_CADASTRAL"],
  PENDENCIA_CADASTRAL: ["EM_VALIDACAO", "APTO_CONTATO"],
  APTO_PREPOSTAGEM: ["INCLUIDO_EM_LOTE"],
  INCLUIDO_EM_LOTE: ["POSTADO", "APTO_PREPOSTAGEM"],
  POSTADO: [],
};

export class PfTransitionError extends Error {
  constructor(readonly from: PfConfirmationStatus, readonly to: PfConfirmationStatus) {
    super(`Transição PF inválida: ${from} -> ${to}`);
    this.name = "PfTransitionError";
  }
}

export function validarTransicaoPf(
  from: PfConfirmationStatus,
  to: PfConfirmationStatus,
): void {
  if (!TRANSITIONS[from].includes(to)) throw new PfTransitionError(from, to);
}

export function transicoesPf(status: PfConfirmationStatus): readonly PfConfirmationStatus[] {
  return TRANSITIONS[status];
}
