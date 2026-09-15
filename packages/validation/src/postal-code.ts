import { somenteDigitos } from "./digits.js";

export function normalizarCep(value: string): string {
  const cep = somenteDigitos(value);
  if (cep.length !== 8) throw new Error("CEP deve conter exatamente 8 dígitos");
  return cep;
}
