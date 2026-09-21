export interface ApiErrorBody {
  readonly erro?: string;
  readonly codigo?: string;
  readonly detalhes?: readonly string[];
}

/**
 * Produz mensagem operacional sem expor payload/PII. O backend só envia
 * detalhes estruturais de mapping (nomes de campos e índices de colunas)
 * para MAPPING_INVALID; demais respostas permanecem genéricas.
 */
export function mensagemErroApi(body: ApiErrorBody, status: number): string {
  const base = body.erro ?? `HTTP ${status}`;
  if (
    body.codigo === "MAPPING_INVALID" &&
    Array.isArray(body.detalhes) &&
    body.detalhes.length > 0
  ) {
    return `${base} ${body.detalhes.join(" ")}`;
  }
  return base;
}
