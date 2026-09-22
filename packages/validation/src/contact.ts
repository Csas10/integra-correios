export function emailValido(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Telefone operacional exigido para APTO_CONTATO (contrato PF):
 * 10 ou 11 dígitos (DDD + telefone/celular), após remover não-dígitos;
 * sequências de dígitos todos iguais são consideradas inválidas
 * (fixture sintética reconhecível, nunca dado real).
 */
export function telefoneValido(value: string): boolean {
  const digitos = value.replace(/\D/g, "");
  if (digitos.length !== 10 && digitos.length !== 11) return false;
  return !/^(\d)\1+$/.test(digitos);
}
