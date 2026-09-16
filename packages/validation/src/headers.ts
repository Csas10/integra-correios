export interface ResultadoCabecalhos {
  readonly valid: boolean;
  readonly missing: readonly string[];
  readonly duplicated: readonly string[];
}

function canonical(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
}

export function validarCabecalhos(
  received: readonly string[],
  required: readonly string[],
): ResultadoCabecalhos {
  const counts = new Map<string, number>();
  for (const header of received) {
    const key = canonical(header);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const missing = required.filter((header) => !counts.has(canonical(header)));
  const duplicated = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([header]) => header)
    .sort();

  return { valid: missing.length === 0 && duplicated.length === 0, missing, duplicated };
}
