import type { Sha256 } from "./sha256.js";

export interface EventoAuditoria {
  readonly id: string;
  readonly ocorreuEm: string;
  readonly tipo: string;
  readonly agregadoId: string;
  readonly artefatoSha256?: Sha256;
  readonly metadados: Readonly<Record<string, string | number | boolean | null>>;
}

export interface NovoEventoAuditoria {
  readonly id: string;
  readonly ocorreuEm: Date;
  readonly tipo: string;
  readonly agregadoId: string;
  readonly artefatoSha256?: Sha256;
  readonly metadados?: Readonly<Record<string, string | number | boolean | null>>;
}

export function criarEventoAuditoria(input: NovoEventoAuditoria): EventoAuditoria {
  const base = {
    id: input.id,
    ocorreuEm: input.ocorreuEm.toISOString(),
    tipo: input.tipo,
    agregadoId: input.agregadoId,
    metadados: Object.freeze({ ...(input.metadados ?? {}) }),
  };
  return Object.freeze(
    input.artefatoSha256 === undefined
      ? base
      : { ...base, artefatoSha256: input.artefatoSha256 },
  );
}
