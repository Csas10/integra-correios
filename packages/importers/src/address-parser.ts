/**
 * Parser ASSISTIDO do campo composto ENDERECO.
 *
 * Regras inegociáveis:
 *  - endereco_origem é SEMPRE preservado pelo chamador — este módulo apenas
 *    SUGESTIONA a decomposição; nunca substitui o valor importado;
 *  - nenhuma correção automática silenciosa: resultado ambíguo é classificado
 *    como REVIEW_REQUIRED e mantido pendente para revisão do operador;
 *  - sem chamadas externas (nada de CEP online nesta fase).
 */

/** Classificação do resultado do parsing assistido. */
export type ClassificacaoEndereco = "PARSED" | "REVIEW_REQUIRED" | "INVALID";

export interface EnderecoSugerido {
  readonly logradouro: string;
  readonly numero: string;
  readonly complemento: string;
  readonly bairro: string;
  readonly cidade: string;
  readonly uf: string;
  readonly cep: string;
}

export interface ResultadoParsingEndereco {
  readonly classificacao: ClassificacaoEndereco;
  /** Decomposição sugerida — preenchida somente quando há confiança mínima. */
  readonly sugerido: EnderecoSugerido;
  /** Issues compreensíveis ao operador (sem PII além do próprio endereço). */
  readonly issues: readonly string[];
}

const UFS_VALIDAS = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG",
  "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);

function normalizar(texto: string): string {
  return texto.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Extrai o CEP (8 dígitos, com ou sem hífen) e o remove da linha. */
function extrairCep(linha: string): { cep: string; resto: string } {
  const match = linha.match(/(\d{5})\s*-?\s*(\d{3})/);
  if (!match) return { cep: "", resto: linha };
  const cep = `${match[1]}${match[2]}`;
  const resto = normalizar(linha.replace(match[0], " "));
  return { cep, resto };
}

/** Extrai UF (duas letras isoladas, preferencialmente no fim) e a remove.
 * O restante preserva os separadores originais (",", " - ", "/"): as etapas
 * seguintes (número, segmentos) dependem deles — juntar os tokens com espaço
 * destruiria a estrutura e impediria o PARSED de endereços completos.
 */
function extrairUf(linha: string): { uf: string; resto: string } {
  const re =
    /(?:^|[\s\-–,.\/])\s*(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)(?=[\s\-–,.\/]|$)/g;
  const matches = [...linha.matchAll(re)];
  for (let i = matches.length - 1; i >= Math.max(0, matches.length - 3); i--) {
    const match = matches[i]!;
    const uf = match[1]!.toUpperCase();
    const inicio = match.index ?? 0;
    const resto = normalizar(
      `${linha.slice(0, inicio)} ${linha.slice(inicio + match[0].length)}`
        .replace(/ {2,}/g, " "),
    );
    return { uf, resto };
  }
  return { uf: "", resto: linha };
}

/**
 * Extrai o número inicial do logradouro ("Rua A, 10 - Sala 2" → 10) e o
 * remove. Números caem no logradouro quando não há separador claro.
 */
function extrairNumero(linha: string): { numero: string; resto: string } {
  const match = linha.match(/(?:,\s*|\sn[ºo°]?\s*|\s-\s*)(\d+[A-Za-z]?(?:\s*\/\s*\d+)?)\b/);
  if (!match) return { numero: "", resto: linha };
  const numero = match[1]!;
  const resto = normalizar(linha.replace(match[0], ", "));
  return { numero, resto };
}

const PREFIXOS_LOGRADOURO = [
  "RUA", "AVENIDA", "AV", "TRAVESSA", "TV", "ALAMEDA", "AL", "PRAÇA", "PC",
  "RODOVIA", "BR", "ESTRADA", "ESCADA", "BECO", "CONJUNTO", "CJ", "QUADRA", "QD",
];

function temPrefixoLogradouro(texto: string): boolean {
  const primeira = texto.toUpperCase().split(" ")[0] ?? "";
  return PREFIXOS_LOGRADOURO.includes(primeira.replace(/[.:,]/g, ""));
}

/**
 * Decompõe um ENDERECO composto em logradouro/numero/complemento/bairro/
 * cidade/UF/CEP de forma heurística e transparente.
 *
 * Estratégia: extrair primeiro os campos com formato inequívoco (CEP, UF,
 * número) e distribuir o restante por separadores (" - ", ","). Qualquer
 * lacuna não inferida vira issue — nunca inventamos valor.
 */
export function parsearEnderecoComposto(origem: string): ResultadoParsingEndereco {
  const issues: string[] = [];
  const original = normalizar(origem);

  if (!original) {
    return {
      classificacao: "INVALID",
      sugerido: vazio(),
      issues: ["ENDERECO vazio."],
    };
  }

  const { cep, resto: semCep } = extrairCep(original);
  if (!cep) issues.push("CEP não detectado no ENDERECO composto.");

  const { uf, resto: semUf } = extrairUf(semCep);
  if (!uf) issues.push("UF não detectada no ENDERECO composto.");

  const { numero, resto: semNumero } = extrairNumero(semUf);
  if (!numero) issues.push("Número não detectado no ENDERECO composto.");

  // Segmentos restantes: separadores " - ", " / ", "," dividem
  // logradouro | bairro | cidade (ordem mais comum nas bases CRT).
  const segmentos = semNumero
    .split(/\s+-\s+|\s+\/\s+|,/)
    .map(normalizar)
    .filter(Boolean);

  const complemento = segmentos.length > 3 ? segmentos.slice(3).join(" - ") : "";
  const sugerido: EnderecoSugerido = {
    logradouro: segmentos[0] ?? "",
    numero,
    complemento,
    bairro: segmentos[1] ?? "",
    cidade: segmentos[2] ?? "",
    uf,
    cep,
  };

  let classificacao: ClassificacaoEndereco;
  if (!sugerido.logradouro) {
    classificacao = "INVALID";
    issues.push("Logradouro não pôde ser extraído do ENDERECO composto.");
  } else if (
    !cep ||
    !uf ||
    !numero ||
    !sugerido.bairro ||
    !sugerido.cidade ||
    !temPrefixoLogradouro(sugerido.logradouro)
  ) {
    classificacao = "REVIEW_REQUIRED";
    if (!sugerido.bairro) issues.push("Bairro não pôde ser separado do endereço composto.");
    if (!sugerido.cidade) issues.push("Cidade não pôde ser separada do endereço composto.");
    if (!temPrefixoLogradouro(sugerido.logradouro)) {
      issues.push("Primeiro segmento sem prefixo de logradouro reconhecido — confirme manualmente.");
    }
  } else {
    classificacao = "PARSED";
  }

  return { classificacao, sugerido, issues };
}

function vazio(): EnderecoSugerido {
  return {
    logradouro: "",
    numero: "",
    complemento: "",
    bairro: "",
    cidade: "",
    uf: "",
    cep: "",
  };
}
