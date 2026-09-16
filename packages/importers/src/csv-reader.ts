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

/**
 * Divide uma linha CSV respeitando aspas ("a,b" é um campo; """" vira ").
 * Linha vazia → [].
 */
function dividirLinha(linha: string, delimitador: string): string[] {
  const campos: string[] = [];
  let atual = "";
  let dentroAspas = false;
  for (let i = 0; i < linha.length; i++) {
    const ch = linha[i] as string;
    if (dentroAspas) {
      if (ch === '"') {
        const next = linha[i + 1];
        if (next === '"') {
          atual += '"';
          i++;
        } else {
          dentroAspas = false;
        }
      } else {
        atual += ch;
      }
    } else if (ch === '"' && atual === "") {
      dentroAspas = true;
    } else if (ch === delimitador) {
      campos.push(atual);
      atual = "";
    } else {
      atual += ch;
    }
  }
  campos.push(atual);
  return campos;
}

/**
 * Leitura segura de CSV (UTF-8 strict).
 * - Mesmos limites do XLSX.
 * - Preservação textual de CPF/CNPJ/CEP.
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

  const linhasBrutas = texto.split(/\r\n|\n|\r/);
  if (linhasBrutas.length < linhaCabecalho) {
    throw new LeituraSeguraError(
      `Arquivo tem ${linhasBrutas.length} linhas — insuficiente para o cabeçalho na linha ${linhaCabecalho}.`,
    );
  }

  const cabecalhos = dividirLinha(linhasBrutas[linhaCabecalho - 1] as string, delimitador);
  const duplicados = detectarCabecalhosDuplicados(cabecalhos);

  const linhas: LinhaDados[] = [];
  for (let i = linhaCabecalho; i < linhasBrutas.length; i++) {
    const bruta = linhasBrutas[i] as string;
    // Pula linhas completamente vazias (comum no final do arquivo).
    if (bruta.trim() === "") continue;
    const campos = dividirLinha(bruta, delimitador);
    const celulas: Celula[] = campos.map((texto, col) => ({ coluna: col, texto }));
    linhas.push({ numero: i + 1, celulas });
  }

  if (linhas.length > limites.maxLinhas) {
    throw new LeituraSeguraError(
      `Arquivo excede o limite de ${limites.maxLinhas} linhas de dados (${linhas.length}).`,
    );
  }
  const totalColunas = Math.max(cabecalhos.length, ...linhas.map((l) => l.celulas.length), 0);
  if (totalColunas > limites.maxColunas) {
    throw new LeituraSeguraError(
      `Arquivo excede o limite de ${limites.maxColunas} colunas (${totalColunas}).`,
    );
  }

  const folha: FolhaExtraida = {
    nome: "CSV",
    linhaCabecalho,
    cabecalhos,
    linhas,
  };

  return {
    sha256: sha256Arquivo(arquivo),
    folha,
    cabecalhosDuplicados: duplicados,
  };
}
