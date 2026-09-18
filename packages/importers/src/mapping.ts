import {
  normalizarCabecalho,
  CAMPOS_SENSIVEIS_A_ZEROS,
  type FolhaExtraida,
  type LinhaDados,
} from "./safe-read.js";

/** Origens com contrato próprio de obrigatoriedade. */
export type OrigemMapeamento = "PF" | "PJ";

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
  "CELULAR",
  "ENDERECO_COMPOSTO",
  "EMAIL",
] as const;

export type Campo = (typeof CAMPOS_TODOS)[number];

/**
 * Obrigatoriedade distinta por origem.
 * - PF: campos do workflow de confirmação cadastral (pf-workflow).
 * - PJ: razão social e fantasia, sem dependentes do fluxo PF.
 * ORIGEM é sempre obrigatória (segregação de identidade).
 */
export const CAMPOS_OBRIGATORIOS: Readonly<
  Record<OrigemMapeamento, readonly Campo[]>
> = {
  PF: ["ORIGEM", "CODIGO", "NOME", "CPF_CNPJ", "ENDERECO_COMPOSTO", "TELEFONE"],
  PJ: ["ORIGEM", "CODIGO", "NOME", "NOME_FANTASIA", "CPF_CNPJ", "CEP", "LOGRADOURO", "CIDADE", "UF"],
};

/** Aliases canônicos usados na sugestão automática de mapeamento. */
const ALIASES: Readonly<Record<Campo, readonly string[]>> = {
  ORIGEM: ["ORIGEM", "TIPO", "PF PJ", "PESSOA"],
  CODIGO: ["CODIGO", "ID", "COD", "CODIGO INTERNO"],
  NOME: ["NOME", "NOME COMPLETO", "RAZAO SOCIAL", "NOME RAZAO SOCIAL"],
  NOME_FANTASIA: ["NOME FANTASIA", "FANTASIA"],
  CPF_CNPJ: ["CPF", "CPF CNPJ", "CPFCNPJ", "DOCUMENTO", "CPF/CNPJ", "REGISTRO NACIONAL"],
  CEP: ["CEP", "CEP RESIDENCIAL", "CEP DO ENDERECO"],
  LOGRADOURO: ["LOGRADOURO", "RUA"],
  NUMERO: ["NUMERO", "NUM", "N"],
  COMPLEMENTO: ["COMPLEMENTO", "COMPL"],
  BAIRRO: ["BAIRRO"],
  CIDADE: ["CIDADE", "MUNICIPIO"],
  UF: ["UF", "ESTADO", "UNIDADE FEDERATIVA"],
  TELEFONE: ["TELEFONE", "TEL", "FONE"],
  CELULAR: ["CELULAR", "WHATSAPP", "CEL"],
  ENDERECO_COMPOSTO: ["ENDERECO", "ENDERECO COMPLETO", "LOGRADOURO COMPLETO"],
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

/** Marca privada: somente confirmarMapeamento pode criar este contrato. */
const MAPEAMENTO_CONFIRMADO: unique symbol = Symbol("MapeamentoConfirmado");

/**
 * Mapeamento validado e explicitamente confirmado pelo operador.
 * A marca é privada ao módulo para impedir construção estrutural acidental.
 */
export interface MapeamentoConfirmado {
  readonly itens: readonly ItemMapeamento[];
  readonly origem: OrigemMapeamento;
  readonly totalColunas: number;
  readonly [MAPEAMENTO_CONFIRMADO]: true;
}

/**
 * Valida o mapeamento contra a obrigatoriedade da origem informada.
 * `origem` é a origem do fluxo de ingestão (PF ou PJ) — o mesmo conjunto
 * de campos obrigatórios não se aplica às duas.
 */
export function validarMapeamento(
  mapeamento: Mapeamento,
  totalColunas: number,
  origem: OrigemMapeamento,
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
  for (const obrigatorio of CAMPOS_OBRIGATORIOS[origem]) {
    if (!campos.has(obrigatorio)) {
      erros.push(`Campo obrigatório não mapeado (${origem}): ${obrigatorio}.`);
    }
  }
  return erros;
}

/**
 * Fronteira explícita da confirmação do operador. Valida e congela uma cópia
 * do mapeamento; aplicarMapeamento não aceita o contrato estrutural comum.
 *
 * Fluxo institucional PF (base real CRT): a base possui ENDERECO composto
 * (sem CEP/UF/logradouro decompostos), então os obrigatórios PF são
 * CODIGO/NOME/CPF/ENDERECO_COMPOSTO/TELEFONE. O parsing assistido do
 * endereço (address-parser) sugere a decomposição depois, sempre com
 * endereco_origem preservado e revisão do operador quando ambíguo.
 */
export function confirmarMapeamento(
  mapeamento: Mapeamento,
  totalColunas: number,
  origem: OrigemMapeamento,
): MapeamentoConfirmado {
  const erros = validarMapeamento(mapeamento, totalColunas, origem);
  if (erros.length > 0) {
    throw new Error(`Mapeamento inválido: ${erros.join(" ")}`);
  }
  const itens = Object.freeze(
    mapeamento.itens.map((item) => Object.freeze({ ...item })),
  );
  return Object.freeze({
    itens,
    origem,
    totalColunas,
    [MAPEAMENTO_CONFIRMADO]: true as const,
  });
}

/**
 * Perfil de mapeamento versionado, reutilizável e auditável:
 * registra a origem, a folha e a linha de cabeçalho para que a
 * reaplicação a outro workbook seja inequívoca.
 */
export interface PerfilMapeamento {
  readonly nome: string;
  readonly versao: number;
  readonly origem: OrigemMapeamento;
  readonly folha: string | null;
  readonly linhaCabecalho: number;
  readonly mapeamento: Mapeamento;
}

export function criarPerfil(
  nome: string,
  versao: number,
  contexto: {
    readonly origem: OrigemMapeamento;
    readonly folha: string | null;
    readonly linhaCabecalho: number;
  },
  mapeamento: Mapeamento,
): PerfilMapeamento {
  if (!nome.trim()) throw new Error("Perfil exige nome.");
  if (!Number.isInteger(versao) || versao < 1) throw new Error("Versão deve ser inteiro >= 1.");
  if (contexto.origem !== "PF" && contexto.origem !== "PJ") {
    throw new Error("Perfil exige origem PF ou PJ.");
  }
  if (!Number.isInteger(contexto.linhaCabecalho) || contexto.linhaCabecalho < 1) {
    throw new Error("linhaCabecalho do perfil deve ser inteiro >= 1.");
  }
  return {
    nome: nome.trim(),
    versao,
    origem: contexto.origem,
    folha: contexto.folha,
    linhaCabecalho: contexto.linhaCabecalho,
    mapeamento,
  };
}

export interface LinhaMapeada {
  readonly numero: number;
  /** Valores por campo do domínio, preservados como texto cru. */
  readonly valores: Readonly<Partial<Record<Campo, string>>>;
  /**
   * Campos sensíveis a zeros à esquerda (CPF_CNPJ/CEP) cuja célula de
   * origem era numérica — fail-closed, exige tratamento pelo operador.
   */
  readonly alertasNumericos: readonly string[];
}

export interface ResultadoAplicacao {
  readonly linhas: readonly LinhaMapeada[];
}

/**
 * Aplica um mapeamento CONFIRMADO a uma folha extraída.
 * Células numéricas mapeadas para campos sensíveis a zeros à esquerda
 * (CPF_CNPJ, CEP) geram alerta — não são aceitas silenciosamente.
 */
export function aplicarMapeamento(
  folha: FolhaExtraida,
  mapeamento: MapeamentoConfirmado,
): ResultadoAplicacao {
  if (mapeamento[MAPEAMENTO_CONFIRMADO] !== true) {
    throw new Error("Mapeamento não foi confirmado explicitamente pelo operador.");
  }
  if (mapeamento.totalColunas !== folha.cabecalhos.length) {
    throw new Error(
      `Mapeamento confirmado para ${mapeamento.totalColunas} colunas, mas a folha possui ${folha.cabecalhos.length}.`,
    );
  }
  const linhas = folha.linhas.map((linha: LinhaDados) => {
    const valores: Partial<Record<Campo, string>> = {};
    const alertasNumericos: string[] = [];
    for (const item of mapeamento.itens) {
      const celula = linha.celulas[item.coluna];
      valores[item.campo] = celula ? celula.texto : "";
      if (celula && celula.tipoOrigem === "numero" && CAMPOS_SENSIVEIS_A_ZEROS.has(item.campo)) {
        alertasNumericos.push(
          `${item.campo} (linha ${linha.numero}): célula numérica pode ter perdido zeros à esquerda — reformate a coluna como texto na planilha.`,
        );
      }
    }
    return { numero: linha.numero, valores, alertasNumericos };
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
 * - ORIGEM deve ser PF ou PJ e corresponder à origem do fluxo.
 * - CEP deve ter 8 dígitos (hífen tolerado).
 * - CPF (PF) e CNPJ (PJ) têm validadores distintos.
 */
export function validarLinhasPfPj(
  linhas: readonly LinhaMapeada[],
  origem: OrigemMapeamento,
  validarCpf: (documento: string) => boolean,
  validarCnpj: (documento: string) => boolean,
): readonly ResultadoValidacaoPfPj[] {
  return linhas.map((linha) => {
    const erros: string[] = [];

    for (const alerta of linha.alertasNumericos) {
      erros.push(`Bloqueio por célula numérica: ${alerta}`);
    }

    const valorOrigem = (linha.valores.ORIGEM ?? "").trim().toUpperCase();
    if (valorOrigem !== origem) {
      erros.push(
        `ORIGEM inválida: "${linha.valores.ORIGEM ?? ""}" (esperado ${origem} para este fluxo).`,
      );
    }

    const cep = (linha.valores.CEP ?? "").replace(/\D/g, "");
    if (cep.length !== 8) {
      erros.push(`CEP inválido: "${linha.valores.CEP ?? ""}" (esperado 8 dígitos).`);
    }

    const documento = (linha.valores.CPF_CNPJ ?? "").replace(/\D/g, "");
    const esperadoDigitos = origem === "PF" ? 11 : 14;
    if (documento.length === 0) {
      erros.push(`CPF/CNPJ vazio (obrigatório para ${origem}).`);
    } else if (documento.length !== esperadoDigitos) {
      erros.push(
        `Documento com ${documento.length} dígitos — esperado ${esperadoDigitos} (${origem === "PF" ? "CPF" : "CNPJ"}).`,
      );
    } else if (origem === "PF" && !validarCpf(documento)) {
      erros.push(`CPF inválido: "${linha.valores.CPF_CNPJ ?? ""}".`);
    } else if (origem === "PJ" && !validarCnpj(documento)) {
      erros.push(`CNPJ inválido: "${linha.valores.CPF_CNPJ ?? ""}".`);
    }

    if (!(linha.valores.CODIGO ?? "").trim()) {
      erros.push("CODIGO vazio.");
    }

    return { numeroLinha: linha.numero, valido: erros.length === 0, erros };
  });
}
