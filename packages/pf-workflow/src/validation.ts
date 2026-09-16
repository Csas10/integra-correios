import {
  cpfValido,
  emailValido,
  normalizarCep,
  ufBrasileiraValida,
} from "@integra-correios/validation";
import type { PfCadastreSnapshot } from "./model.js";

export interface PfValidationResult {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export function validarCadastroPf(snapshot: PfCadastreSnapshot): PfValidationResult {
  const issues: string[] = [];
  if (!cpfValido(snapshot.documento)) issues.push("CPF inválido");
  if (snapshot.nome.trim().length < 2) issues.push("Nome obrigatório");
  if (!emailValido(snapshot.email)) issues.push("E-mail inválido");
  if (!snapshot.telefone.trim()) issues.push("Telefone obrigatório");
  if (!snapshot.endereco.logradouro.trim()) issues.push("Logradouro obrigatório");
  if (!snapshot.endereco.numero.trim()) issues.push("Número obrigatório");
  if (!snapshot.endereco.bairro.trim()) issues.push("Bairro obrigatório");
  if (!snapshot.endereco.cidade.trim()) issues.push("Cidade obrigatória");
  if (!ufBrasileiraValida(snapshot.endereco.uf)) issues.push("UF inválida");
  try {
    normalizarCep(snapshot.endereco.cep);
  } catch {
    issues.push("CEP inválido");
  }
  return { valid: issues.length === 0, issues };
}
