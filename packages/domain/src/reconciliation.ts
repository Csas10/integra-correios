export interface ReconciliacaoContabil {
  readonly enviados: number;
  readonly confirmados: number;
  readonly rejeitados: number;
  readonly reconciliados: number;
  readonly completa: boolean;
}

export function reconciliarContagens(
  enviados: number,
  confirmados: number,
  rejeitados: number,
): ReconciliacaoContabil {
  for (const [nome, valor] of Object.entries({ enviados, confirmados, rejeitados })) {
    if (!Number.isSafeInteger(valor) || valor < 0) {
      throw new Error(`${nome} deve ser inteiro não negativo`);
    }
  }
  const reconciliados = confirmados + rejeitados;
  return {
    enviados,
    confirmados,
    rejeitados,
    reconciliados,
    completa: reconciliados === enviados,
  };
}
