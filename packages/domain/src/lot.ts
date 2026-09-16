import { decomporIdentidade, type IdentidadeOperacional } from "./identity.js";
import type { Origem } from "./origin.js";

export type LoteId = `${Origem}-LOTE${string}`;

export interface ItemLote {
  readonly identidade: IdentidadeOperacional;
}

export interface Lote {
  readonly id: LoteId;
  readonly origem: Origem;
  readonly itens: readonly ItemLote[];
}

export function criarLoteId(origem: Origem, sequencial: number): LoteId {
  if (!Number.isSafeInteger(sequencial) || sequencial < 1 || sequencial > 999_999) {
    throw new Error("Sequencial de lote inválido");
  }
  return `${origem}-LOTE${String(sequencial).padStart(3, "0")}`;
}

export function validarItensDoLote(lote: Lote): void {
  if (!lote.id.startsWith(`${lote.origem}-LOTE`)) {
    throw new Error(`Identificador ${lote.id} incompatível com origem ${lote.origem}`);
  }
  const vistos = new Set<string>();
  for (const item of lote.itens) {
    const { origem } = decomporIdentidade(item.identidade);
    if (origem !== lote.origem) {
      throw new Error(`Origem ${origem} incompatível com lote ${lote.origem}`);
    }
    if (vistos.has(item.identidade)) {
      throw new Error(`Identidade duplicada no lote: ${item.identidade}`);
    }
    vistos.add(item.identidade);
  }
}
