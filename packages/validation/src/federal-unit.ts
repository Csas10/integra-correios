export const UFS_BRASILEIRAS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO",
  "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI",
  "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
] as const;

export type UfBrasileira = (typeof UFS_BRASILEIRAS)[number];

const UFS = new Set<string>(UFS_BRASILEIRAS);

export function ufBrasileiraValida(value: string): value is UfBrasileira {
  return UFS.has(value.trim().toUpperCase());
}
