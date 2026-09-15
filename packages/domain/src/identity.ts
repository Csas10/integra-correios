import { isOrigem, type Origem } from "./origin.js";

export type IdentidadeOperacional = `${Origem}|${string}`;

export function criarIdentidade(origem: Origem, codigo: string): IdentidadeOperacional {
  const normalizado = codigo.trim();
  if (normalizado.length === 0 || normalizado.includes("|")) {
    throw new Error("Código operacional inválido");
  }
  return `${origem}|${normalizado}`;
}

export function decomporIdentidade(identidade: string): {
  origem: Origem;
  codigo: string;
} {
  const separador = identidade.indexOf("|");
  const origem = identidade.slice(0, separador);
  const codigo = identidade.slice(separador + 1);

  if (separador < 1 || !isOrigem(origem) || codigo.length === 0 || codigo.includes("|")) {
    throw new Error("Identidade operacional inválida");
  }

  return { origem, codigo };
}
