import {
  LIMITES_PADRAO,
  LeituraSeguraError,
  detectarCabecalhosDuplicados,
  sha256Arquivo,
  type ArquivoEntrada,
  type Celula,
  type FolhaExtraida,
  type Limites,
  type LinhaDados,
} from "./safe-read.js";

export interface ResultadoLeituraCsv {
  readonly sha256: string;
  readonly folha: FolhaExtraida;
  readonly cabecalhosDuplicados: readonly string[];
}

export interface OpcoesLeituraCsv {
  /** Delimitador (default ","; aceita ";" e "\t"). */
  readonly delimitador?: string;
  /** Linha 1-based do cabeçalho (default 1). */
  readonly linhaCabecalho?: number;
  readonly limites?: Limites;
}

const DELIMITADORES_VALIDOS = new Set([",", ";", "\t"]);

function decodificar(bytes: Uint8Array): string {
  // BOM UTF-8: remove antes de decodificar.
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3)
    : bytes;
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

interface RegistroCsv {
  /** Campos do registro (aspas já resolvidas, quebras internas preservadas). */
  readonly campos: string[];
  /** Número 1-based da linha física onde o registro começa. */
  readonly linhaFisica: number;
  /** Número 1-based da linha física onde o registro termina. */
  readonly linhaFisicaFinal: number;
}

interface ResultadoParseCsv {
  readonly cabecalho: RegistroCsv;
  readonly dados: readonly RegistroCsv[];
}

/**
 * Parser RFC 4180 por estado com limites aplicados durante a leitura:
 * - campos entre aspas podem conter delimitador, aspas ("") e quebras
 *   de linha — o registro só termina fora de aspas;
 * - linha física inicial de cada registro é preservada para auditoria.
 */
function parsearCsv(
  texto: string,
  delimitador: string,
  linhaCabecalho: number,
  limites: { readonly maxLinhas: number; readonly maxColunas: number },
): ResultadoParseCsv {
  let cabecalho: RegistroCsv | undefined;
  const dados: RegistroCsv[] = [];
  let campos: string[] = [];
  let atual = "";
  let dentroAspas = false;
  let linhaFisica = 1;
  let linhaInicioRegistro = 1;
  let registroAberto = false;

  const fecharCampo = (): void => {
    if (campos.length >= limites.maxColunas) {
      throw new LeituraSeguraError(
        `Arquivo excede o limite de ${limites.maxColunas} colunas durante o parsing.`,
      );
    }
    campos.push(atual);
    atual = "";
  };
  const fecharRegistro = (): void => {
    fecharCampo();
    const registro: RegistroCsv = {
      campos,
      linhaFisica: linhaInicioRegistro,
      linhaFisicaFinal: linhaFisica,
    };
    campos = [];
    registroAberto = false;

    if (!cabecalho) {
      if (registro.linhaFisica >= linhaCabecalho) cabecalho = registro;
      return;
    }
    if (registro.campos.length === 1 && registro.campos[0] === "") return;
    if (dados.length >= limites.maxLinhas) {
      throw new LeituraSeguraError(
        `Arquivo excede o limite de ${limites.maxLinhas} linhas de dados durante o parsing.`,
      );
    }
    dados.push(registro);
  };

  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i] as string;
    if (dentroAspas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') {
          atual += '"';
          i++;
        } else {
          dentroAspas = false;
        }
      } else {
        if (ch === "\n" || (ch === "\r" && texto[i + 1] !== "\n")) linhaFisica++;
        atual += ch;
      }
      continue;
    }
    if (ch === '"' && atual === "") {
      dentroAspas = true;
      registroAberto = true;
      continue;
    }
    if (ch === delimitador) {
      fecharCampo();
      registroAberto = true;
      continue;
    }
    if (ch === "\r") {
      if (texto[i + 1] === "\n") i++;
      fecharRegistro();
      linhaFisica++;
      linhaInicioRegistro = linhaFisica;
      continue;
    }
    if (ch === "\n") {
      fecharRegistro();
      linhaFisica++;
      linhaInicioRegistro = linhaFisica;
      continue;
    }
    if (!registroAberto && atual === "" && campos.length === 0) {
      registroAberto = true;
      linhaInicioRegistro = linhaFisica;
    }
    atual += ch;
  }

  if (dentroAspas) {
    throw new LeituraSeguraError(
      `CSV inválido: campo entre aspas iniciado na linha ${linhaInicioRegistro} não foi fechado antes do fim do arquivo.`,
    );
  }

  // Registro final sem quebra de linha, ou campo pendente.
  if (registroAberto || atual !== "" || campos.length > 0) {
    fecharRegistro();
  }
  if (!cabecalho) {
    throw new LeituraSeguraError(
      `Arquivo não contém linha de cabeçalho na posição ${linhaCabecalho}.`,
    );
  }
  return { cabecalho, dados };
}

/**
 * Leitura segura de CSV (UTF-8 strict, RFC 4180).
 * - Mesmos limites do XLSX.
 * - Campos quoted com quebra de linha interna são suportados.
 * - Células CSV são sempre texto (tipoOrigem "texto").
 * - Detecta cabeçalhos duplicados.
 */
export function lerCsv(arquivo: ArquivoEntrada, opcoes: OpcoesLeituraCsv = {}): ResultadoLeituraCsv {
  const limites = { ...LIMITES_PADRAO, ...opcoes.limites };

  if (arquivo.bytes.length > limites.maxArquivoBytes) {
    throw new LeituraSeguraError(
      `Arquivo excede o limite de ${limites.maxArquivoBytes} bytes (${arquivo.bytes.length} recebidos).`,
    );
  }

  const delimitador = opcoes.delimitador ?? ",";
  if (!DELIMITADORES_VALIDOS.has(delimitador)) {
    throw new LeituraSeguraError(
      `Delimitador inválido: "${delimitador}". Use ",", ";" ou tabulação.`,
    );
  }

  let texto: string;
  try {
    texto = decodificar(arquivo.bytes);
  } catch {
    throw new LeituraSeguraError(
      "Arquivo não é UTF-8 válido. Reencode o CSV antes de reenviar.",
    );
  }

  const linhaCabecalho = opcoes.linhaCabecalho ?? 1;
  if (!Number.isInteger(linhaCabecalho) || linhaCabecalho < 1) {
    throw new LeituraSeguraError(`linhaCabecalho deve ser inteiro >= 1 (recebido: ${linhaCabecalho}).`);
  }

  const registros = parsearCsv(texto, delimitador, linhaCabecalho, limites);
  const registroCabecalho = registros.cabecalho;
  // Um cabeçalho não pode conter quebra de linha interna (ambiguidade).
  if (registroCabecalho.linhaFisica !== registroCabecalho.linhaFisicaFinal) {
    throw new LeituraSeguraError("Cabeçalho ambíguo.");
  }

  const cabecalhos = registroCabecalho.campos;
  const duplicados = detectarCabecalhosDuplicados(cabecalhos);

  const linhas: LinhaDados[] = [];
  for (const registro of registros.dados) {
    const celulas: Celula[] = registro.campos.map((texto, col) => ({
      coluna: col,
      texto,
      tipoOrigem: "texto" as const,
    }));
    linhas.push({ numero: registro.linhaFisica, celulas });
  }

  const folha: FolhaExtraida = {
    nome: "CSV",
    linhaCabecalho: registroCabecalho.linhaFisica,
    cabecalhos,
    linhas,
  };

  return {
    sha256: sha256Arquivo(arquivo),
    folha,
    cabecalhosDuplicados: duplicados,
  };
}
