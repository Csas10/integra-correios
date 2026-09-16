import { normalizarCabecalho, type FolhaExtraida } from "./safe-read.js";

/** Campos do domínio PF/PJ exigidos pela fundação (packages/domain). */
export const CAMPOS_TODOS = [
  "ORIGEM",
  "CODIGO",
  "NOME",
  "NOME_FANTASIA",
  "CPF_CNPJ",
  "CEP",
  "LOGRADOURO",
  "NUMERO",
  "COMPLEMENTO",
  "BAIRRO",
  "CIDADE",
  "UF",
  "TELEFONE",
  "EMAIL",
] as const;

export type Campo = (typeof CAMPOS_TODOS)[number];

export const CAMPOS_OBRIGATORIOS: readonly Campo[] = [
  "ORIGEM",
  "CODIGO",
  "NOME",
  "CPF_CNPJ",
  "CEP",
  "LOGRADOURO",
  "CIDADE",
  "UF",
];

/** Aliases canônicos usados na sugestão automática de mapeamento. */
const ALIASES: Readonly<Record<Campo, readonly string[]>> = {
  ORIGEM: ["ORIGEM", "TIPO", "PF PJ", "PESSOA"],
  CODIGO: ["CODIGO", "ID", "COD", "CODIGO INTERNO"],
  NOME: ["NOME", "NOME COMPLETO", "RAZAO SOCIAL", "NOME RAZAO SOCIAL"],
  NOME_FANTASIA: ["NOME FANTASIA", "FANTASIA"],
  CPF_CNPJ: ["CPF CNPJ", "CPFCNPJ", "DOCUMENTO", "CPF/CNPJ"],
  CEP: ["CEP", "CEP RESIDENCIAL", "CEP DO ENDERECO"],
  LOGRADOURO: ["LOGRADOURO", "ENDERECO", "RUA"],
  NUMERO: ["NUMERO", "NUM", "N"],
  COMPLEMENTO: ["COMPLEMENTO", "COMPL"],
  BAIRRO: ["BAIRRO"],
  CIDADE: ["CIDADE", "MUNICIPIO"],
  UF: ["UF", "ESTADO", "UNIDADE FEDERATIVA"],
  TELEFONE: ["TELEFONE", "TEL", "CELULAR", "FONE"],
  EMAIL: ["EMAIL", "E-MAIL", "CORREIO ELETRONICO"],
};

export interface SugestaoMapeamento {
  readonly campo: Campo;
  /** Nome original do cabeçalho sugerido, se houver correspondência. */
  readonly cabecalho: string | null;
  /** Índice 0-based da coluna sugerida, se houver. */
  readonly coluna: number | null;
}

/**
 * Sugestão automática: para cada campo do domínio, procura o primeiro
 * cabeçalho cuja forma canônica casa com um dos aliases do campo.
 * Nunca sugere o mesmo cabeçalho para dois campos.
 */
export function sugerirMapeamento(cabecalhos: readonly string[]): readonly SugestaoMapeamento[] {
  const canonica = cabecalhos.map(normalizarCabecalho);
  const usados = new Set<number>();
  const sugestoes: SugestaoMapeamento[] = [];

  for (const campo of CAMPOS_TODOS) {
    let encontrado: { cabecalho: string; coluna: number } | null = null;
    for (const alias of ALIASES[campo]) {
      const col = canonica.findIndex((h, i) => h === alias && !usados.has(i));
      if (col >= 0) {
        encontrado = { cabecalho: cabecalhos[col] as string, coluna: col };
        break;
      }
    }
    if (encontrado) usados.add(encontrado.coluna);
    sugestoes.push({
      campo,
      cabecalho: encontrado?.cabecalho ?? null,
      coluna: encontrado?.coluna ?? null,
    });
  }
  return sugestoes;
}

export interface ItemMapeamento {
  readonly campo: Campo;
  /** Índice 0-based da coluna confirmada pelo operador. */
  readonly coluna: number;
}

/** Mapeamento confirmado pelo operador (nada é aplicado sem confirmação). */
export interface Mapeamento {
  readonly itens: readonly ItemMapeamento[];
}

export function validarMapeamento(
  mapeamento: Mapeamento,
  totalColunas: number,
): readonly string[] {
  const erros: string[] = [];
  const colunas = new Set<number>();
  const campos = new Set<Campo>();
  for (const item of mapeamento.itens) {
    if (!Number.isInteger(item.coluna) || item.coluna < 0 || item.coluna >= totalColunas) {
      erros.push(`Campo ${item.campo}: coluna ${item.coluna} fora do intervalo (0..${totalColunas - 1}).`);
      continue;
    }
    if (colunas.has(item.coluna)) {
      erros.push(`Campo ${item.campo}: coluna ${item.coluna} já mapeada por outro campo.`);
      continue;
    }
    if (campos.has(item.campo)) {
      erros.push(`Campo ${item.campo} mapeado mais de uma vez.`);
      continue;
    }
    colunas.add(item.coluna);
    campos.add(item.campo);
  }
  for (const obrigatorio of CAMPOS_OBRIGATORIOS) {
    if (!campos.has(obrigatorio)) {
      erros.push(`Campo obrigatório não mapeado: ${obrigatorio}.`);
    }
  }
  return erros;
}

/** Perfil de mapeamento versionado (persistência e reuso entre importações). */
export interface PerfilMapeamento {
  readonly nome: string;
  readonly versao: number;
  readonly mapeamento: Mapeamento;
}

export function criarPerfil(
  nome: string,
  versao: number,
  mapeamento: Mapeamento,
): PerfilMapeamento {
  if (!nome.trim()) throw new Error("Perfil exige nome.");
  if (!Number.isInteger(versao) || versao < 1) throw new Error("Versão deve ser inteiro >= 1.");
  return { nome: nome.trim(), versao, mapeamento };
}

export interface LinhaMapeada {
  readonly numero: number;
  /** Valores por campo do domínio, preservados como texto cru. */
  readonly valores: Readonly<Partial<Record<Campo, string>>>;
}

export interface ResultadoAplicacao {
  readonly linhas: readonly LinhaMapeada[];
}

/** Aplica um mapeamento CONFIRMADO a uma folha extraída. */
export function aplicarMapeamento(
  folha: FolhaExtraida,
  mapeamento: Mapeamento,
): ResultadoAplicacao {
  const erros = validarMapeamento(mapeamento, folha.cabecalhos.length);
  if (erros.length > 0) {
    throw new Error(`Mapeamento inválido: ${erros.join(" ")}`);
  }
  const linhas = folha.linhas.map((linha) => {
    const valores: Partial<Record<Campo, string>> = {};
    for (const item of mapeamento.itens) {
      const celula = linha.celulas[item.coluna];
      valores[item.campo] = celula ? celula.texto : "";
    }
    return { numero: linha.numero, valores };
  });
  return { linhas };
}

export interface ResultadoValidacaoPfPj {
  readonly numeroLinha: number;
  readonly valido: boolean;
  readonly erros: readonly string[];
}

/**
 * Validação PF/PJ das linhas mapeadas.
 * - ORIGEM deve ser PF ou PJ.
 * - CEP deve ter 8 dígitos (hífen tolerado).
 * - CPF/CNPJ devem ter dígitos verificadores válidos (se preenchidos).
 */
export function validarLinhasPfPj(
  linhas: readonly LinhaMapeada[],
  validarDocumento: (documento: string) => boolean,
): readonly ResultadoValidacaoPfPj[] {
  return linhas.map((linha) => {
    const erros: string[] = [];

    const origem = (linha.valores.ORIGEM ?? "").trim().toUpperCase();
    if (origem !== "PF" && origem !== "PJ") {
      erros.push(`ORIGEM inválida: "${linha.valores.ORIGEM ?? ""}" (use PF ou PJ).`);
    }

    const cep = (linha.valores.CEP ?? "").replace(/\D/g, "");
    if (cep.length !== 8) {
      erros.push(`CEP inválido: "${linha.valores.CEP ?? ""}" (esperado 8 dígitos).`);
    }

    const documento = (linha.valores.CPF_CNPJ ?? "").replace(/\D/g, "");
    if (documento.length > 0 && !validarDocumento(documento)) {
      erros.push(`CPF/CNPJ inválido: "${linha.valores.CPF_CNPJ ?? ""}".`);
    }

    if (!(linha.valores.CODIGO ?? "").trim()) {
      erros.push("CODIGO vazio.");
    }

    return { numeroLinha: linha.numero, valido: erros.length === 0, erros };
  });
}

