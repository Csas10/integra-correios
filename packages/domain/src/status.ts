import type { Origem } from "./origin.js";

export const STATUS_OPERACIONAIS = [
  "RECEBIDO",
  "APTO_CONTATO",
  "EMAIL_ENVIADO",
  "AGUARDANDO_CONFIRMACAO",
  "CONFIRMADO_SEM_ALTERACAO",
  "CONFIRMADO_COM_ALTERACAO",
  "EM_VALIDACAO",
  "APTO_PREPOSTAGEM",
  "PENDENTE",
  "EM_LOTE",
  "ENVIADO",
  "CONFIRMADO",
  "REJEITADO",
  "RETESTE",
] as const;

export type StatusOperacional = (typeof STATUS_OPERACIONAIS)[number];

const TRANSICOES_COMUNS: Partial<Record<StatusOperacional, readonly StatusOperacional[]>> = {
  APTO_CONTATO: ["EMAIL_ENVIADO", "PENDENTE"],
  EMAIL_ENVIADO: ["AGUARDANDO_CONFIRMACAO", "PENDENTE"],
  AGUARDANDO_CONFIRMACAO: [
    "CONFIRMADO_SEM_ALTERACAO",
    "CONFIRMADO_COM_ALTERACAO",
    "PENDENTE",
  ],
  CONFIRMADO_SEM_ALTERACAO: ["EM_VALIDACAO"],
  CONFIRMADO_COM_ALTERACAO: ["EM_VALIDACAO"],
  EM_VALIDACAO: ["APTO_PREPOSTAGEM", "PENDENTE"],
  APTO_PREPOSTAGEM: ["EM_LOTE"],
  PENDENTE: ["APTO_CONTATO", "EM_VALIDACAO", "RETESTE"],
  EM_LOTE: ["ENVIADO", "APTO_PREPOSTAGEM"],
  ENVIADO: ["CONFIRMADO", "REJEITADO"],
  REJEITADO: ["PENDENTE", "RETESTE"],
  RETESTE: ["EM_VALIDACAO"],
};

const TRANSICOES_RECEBIDO: Record<Origem, readonly StatusOperacional[]> = {
  PF: ["APTO_CONTATO", "PENDENTE"],
  PJ: ["EM_VALIDACAO", "PENDENTE"],
};

export class TransicaoInvalidaError extends Error {
  constructor(
    readonly origem: Origem,
    readonly de: StatusOperacional,
    readonly para: StatusOperacional,
  ) {
    super(`Transição inválida para ${origem}: ${de} -> ${para}`);
    this.name = "TransicaoInvalidaError";
  }
}

export function transicoesPermitidas(
  origem: Origem,
  status: StatusOperacional,
): readonly StatusOperacional[] {
  if (status === "RECEBIDO") return TRANSICOES_RECEBIDO[origem];
  return TRANSICOES_COMUNS[status] ?? [];
}

export function validarTransicao(
  origem: Origem,
  de: StatusOperacional,
  para: StatusOperacional,
): void {
  if (!transicoesPermitidas(origem, de).includes(para)) {
    throw new TransicaoInvalidaError(origem, de, para);
  }
}
