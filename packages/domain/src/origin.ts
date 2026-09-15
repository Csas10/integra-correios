export const ORIGENS = ["PF", "PJ"] as const;

export type Origem = (typeof ORIGENS)[number];

export function isOrigem(value: string): value is Origem {
  return ORIGENS.includes(value as Origem);
}
