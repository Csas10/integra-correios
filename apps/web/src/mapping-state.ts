export type EstadoMapeamento = Readonly<Record<string, number>>;

/**
 * Aplica a seleção do <select> de mapping sem converter a opção vazia em 0.
 *
 * Em JavaScript, Number("") === 0; portanto usar Number(value) diretamente
 * transforma "— não mapeado —" em coluna 0 e pode criar duplicidade falsa
 * com CODIGO. Valor vazio remove o campo do mapping; valor numérico válido
 * grava o índice selecionado.
 */
export function atualizarSelecaoMapeamento(
  atual: EstadoMapeamento,
  campo: string,
  valor: string,
): Record<string, number> {
  if (valor === "") {
    const proximo = { ...atual };
    delete proximo[campo];
    return proximo;
  }
  const coluna = Number(valor);
  if (!Number.isInteger(coluna) || coluna < 0) {
    throw new Error("Índice de coluna inválido no mapping.");
  }
  return { ...atual, [campo]: coluna };
}
