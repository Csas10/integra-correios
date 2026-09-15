export function somenteDigitos(value: string): string {
  return value.replace(/\D/g, "");
}

export function identificadorComZeros(value: string, length: number): string {
  const digits = somenteDigitos(value);
  if (digits.length === 0 || digits.length > length) {
    throw new Error(`Identificador deve conter de 1 a ${length} dígitos`);
  }
  return digits.padStart(length, "0");
}
