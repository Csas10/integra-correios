import { createHash } from "node:crypto";

/**
 * Limites de segurança da leitura (cap defaults and guards for intake reads).
 */
export const LIMITES_PADRAO = {
  /** Tamanho máximo do arquivo em bytes (20 MB). */
  maxArquivoBytes: 20 * 1024 * 1024,
  /** Máximo de linhas de data rows (sem cabeçalho). */
  maxLinhas: 20_000,
  /** Máximo de colunas. */
  maxColunas: 256,
  /** Máximo de folhas consideradas num XLSX. */
  maxFolhas: 20,
} as const;

export type Limites = Partial<typeof LIMITES_PADRAO>;

export interface ArquivoEntrada {
  readonly nome: string;
  readonly bytes: Uint8Array;
}

/** SHA-256 hex do arquivo original — evidência de auditoria, imutável. */
export function sha256Arquivo(arquivo: ArquivoEntrada): string {
  return createHash("sha256").update(arquivo.bytes).digest("hex");
}

/** Célula bruta: valor interpretado como texto, SEM conversão de tipo. */
export interface Celula {
  /** Texto cru preservado (ex.: "06834140000100", "01234-567"). */
  readonly texto: string;
  /** Índice da coluna (0-based). */
  readonly coluna: number;
}

export interface LinhaDados {
  readonly numero: number;
  readonly celulas: readonly Celula[];
}

export interface FolhaExtraida {
  readonly nome: string;
  readonly linhaCabecalho: number;
  cabecalhos: readonly string[];
  linhas: readonly LinhaDados[];
}

export class LeituraSeguraError extends Error {}

export function normalizarNomeFolha(nome: string): string {
  return nome.trim().toUpperCase();
}

/**
 * Normaliza um cabeçalho: remove acentos, trim e uppercase (mesma regra
 * canônica de packages/validation/src/headers.ts).
 */
export function normalizarCabecalho(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * Detecção de cabeçalhos duplicados por forma canônica ("NOME" vs "nome"
 * vs "NOME " são o mesmo canônico). Preserva as formas originais.
 */
export function detectarCabecalhosDuplicados(
  cabecalhos: readonly string[],
): readonly string[] {
  const counts = new Map<string, { original: string; count: number }>();
  for (const header of cabecalhos) {
    const key = normalizarCabecalho(header);
    const entry = counts.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      counts.set(key, { original: header, count: 1 });
    }
  }
  return [...counts.values()]
    .filter((entry) => entry.count > 1)
    .map((entry) => entry.original)
    .sort();
}
