import * as XLSX from "xlsx";
import {
  LIMITES_PADRAO,
  LeituraSeguraError,
  detectarCabecalhosDuplicados,
  normalizarNomeFolha,
  sha256Arquivo,
  type ArquivoEntrada,
  type Celula,
  type FolhaExtraida,
  type Limites,
  type LinhaDados,
} from "./safe-read.js";

/**
 * Extensões com risco de macro/conteúdo executável.
 */
const EXTENSOES_BLOQUEADAS = new Set([
  ".xls",
  ".xlsm",
  ".xlsb",
  ".xla",
  ".xltm",
  ".xlt",
]);

export interface ResultadoLeituraXlsx {
  readonly sha256: string;
  readonly folhasDisponiveis: readonly string[];
  /** Folha efetivamente extraída (selecionada explicitamente ou a única). */
  readonly folha: FolhaExtraida;
  /** Cabeçalhos duplicados detectados na folha extraída (formas originais). */
  readonly cabecalhosDuplicados: readonly string[];
}

export interface OpcoesLeituraXlsx {
  /** Nome da folha a extrair; se ausente, exige folha única. */
  readonly folha?: string;
  /** Linha 1-based do cabeçalho (default 1). */
  readonly linhaCabecalho?: number;
  readonly limites?: Limites;
}

/** Obtém uma célula do sheet, suportando modo denso e modo esparso. */
function obterCelula(
  sheet: XLSX.WorkSheet,
  r: number,
  c: number,
): XLSX.CellObject | undefined {
  const qualquer = sheet as unknown as Record<string, unknown>;
  const denseRows = qualquer["!data"];
  // Modo denso (SheetJS ≥0.19): linhas em "!data"; senão, chaves numéricas
  // como arrays por linha; senão, modo esparso clássico "A1".
  if (Array.isArray(denseRows)) {
    const row = denseRows[r] as unknown[] | undefined;
    return row?.[c] as XLSX.CellObject | undefined;
  }
  const linhaPorIndice = qualquer[String(r)];
  if (Array.isArray(linhaPorIndice)) {
    return linhaPorIndice[c] as XLSX.CellObject | undefined;
  }
  const addr = XLSX.utils.encode_cell({ r, c });
  return sheet[addr] as XLSX.CellObject | undefined;
}

function celulaTexto(cell: XLSX.CellObject | undefined, linha: number, col: number): string {
  if (!cell) return "";
  if (cell.t === "e") {
    // Célula de erro de fórmula (#REF!, #N/A, ...) — bloqueia a ingestão.
    throw new LeituraSeguraError(
      `Linha ${linha}, coluna ${col + 1}: célula com erro de fórmula (${String(cell.v)}) não é aceita na ingestão.`,
    );
  }
  if (cell.t === "d" || cell.v instanceof Date) {
    throw new LeituraSeguraError(
      `Linha ${linha}, coluna ${col + 1}: célula do tipo data não é suportada. Converta para texto na planilha de entrada.`,
    );
  }
  const v = cell.v;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v ?? "");
}

/**
 * Leitura segura de XLSX.
 * - Rejeita extensões de macro/executável (.xls, .xlsm, .xlsb, ...).
 * - Rejeita arquivos acima do limite de tamanho.
 * - Rejeita workbooks sem folhas legíveis (criptografados/corrompidos).
 * - Preserva CPF/CNPJ/CEP como texto cru (sem conversão de tipo).
 * - Detecta cabeçalhos duplicados (por forma canônica).
 */
export function lerXlsx(
  arquivo: ArquivoEntrada,
  opcoes: OpcoesLeituraXlsx = {},
): ResultadoLeituraXlsx {
  const limites = { ...LIMITES_PADRAO, ...opcoes.limites };

  const nomeLower = arquivo.nome.toLowerCase();
  for (const ext of EXTENSOES_BLOQUEADAS) {
    if (nomeLower.endsWith(ext)) {
      throw new LeituraSeguraError(
        `Formato com risco de macro/executável bloqueado: "${ext}". Use .xlsx (sem macros).`,
      );
    }
  }

  if (arquivo.bytes.length > limites.maxArquivoBytes) {
    throw new LeituraSeguraError(
      `Arquivo excede o limite de ${limites.maxArquivoBytes} bytes (${arquivo.bytes.length} recebidos).`,
    );
  }

  let workbook: XLSX.WorkBook;
  try {
    // `dense: true` reduz consumo de memória; `cellText: false` evita gerar
    // o campo `.w` (texto formatado) — usamos apenas `.v` bruto.
    workbook = XLSX.read(arquivo.bytes, { type: "array", dense: true, cellText: false });
  } catch (err) {
    throw new LeituraSeguraError(
      `Falha ao interpretar o arquivo XLSX: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Workbooks criptografados/corrompidos: SheetJS devolve workbook sem folhas.
  const nomesFolhas = workbook.SheetNames.slice(0, limites.maxFolhas);
  if (nomesFolhas.length === 0) {
    throw new LeituraSeguraError(
      "Arquivo não contém folhas legíveis. Pode estar criptografado ou corrompido — ingestão não autorizada.",
    );
  }

  const folhaSelecionada = opcoes.folha
    ? nomesFolhas.find(
        (nome) => normalizarNomeFolha(nome) === normalizarNomeFolha(opcoes.folha as string),
      )
    : undefined;

  if (opcoes.folha && !folhaSelecionada) {
    throw new LeituraSeguraError(
      `Folha "${opcoes.folha}" não encontrada. Disponíveis: ${nomesFolhas.join(", ")}.`,
    );
  }

  // Sem seleção explícita: exige folha única (evita seleção ambígua).
  if (!folhaSelecionada && nomesFolhas.length > 1) {
    throw new LeituraSeguraError(
      `Arquivo contém ${nomesFolhas.length} folhas. Selecione uma explicitamente: ${nomesFolhas.join(", ")}.`,
    );
  }
  const nomeFolha = folhaSelecionada ?? (nomesFolhas[0] as string);

  const sheet = workbook.Sheets[nomeFolha];
  if (!sheet) throw new LeituraSeguraError(`Folha "${nomeFolha}" não pôde ser aberta.`);

  const range = sheet["!ref"];
  if (!range) {
    throw new LeituraSeguraError(`Folha "${nomeFolha}" está vazia.`);
  }

  const linhaCabecalho = opcoes.linhaCabecalho ?? 1;
  if (!Number.isInteger(linhaCabecalho) || linhaCabecalho < 1) {
    throw new LeituraSeguraError(
      `linhaCabecalho deve ser inteiro >= 1 (recebido: ${linhaCabecalho}).`,
    );
  }

  const decoded = XLSX.utils.decode_range(range);
  const totalColunas = decoded.e.c + 1;
  if (totalColunas > limites.maxColunas) {
    throw new LeituraSeguraError(
      `Folha "${nomeFolha}" excede o limite de ${limites.maxColunas} colunas (${totalColunas}).`,
    );
  }
  if (decoded.e.r + 1 > limites.maxLinhas + linhaCabecalho) {
    throw new LeituraSeguraError(
      `Folha "${nomeFolha}" excede o limite de ${limites.maxLinhas} linhas de dados.`,
    );
  }

  // Cabeçalhos: leitura crua da linha do cabeçalho, como texto.
  const cabecalhos: string[] = [];
  for (let col = decoded.s.c; col <= decoded.e.c; col++) {
    const cell = obterCelula(sheet, linhaCabecalho - 1, col);
    cabecalhos.push(celulaTexto(cell, linhaCabecalho, col));
  }

  const duplicados = detectarCabecalhosDuplicados(cabecalhos);

  // Linhas de dados: preservação textual de cada célula.
  const linhas: LinhaDados[] = [];
  for (let r = linhaCabecalho; r <= decoded.e.r; r++) {
    const numeroLinha = r + 1; // 1-based, igual à planilha
    const celulas: Celula[] = [];
    for (let col = decoded.s.c; col <= decoded.e.c; col++) {
      const cell = obterCelula(sheet, r, col);
      const texto = celulaTexto(cell, numeroLinha, col);
      celulas.push({ coluna: col, texto });
    }
    linhas.push({ numero: numeroLinha, celulas });
  }

  const folha: FolhaExtraida = {
    nome: nomeFolha,
    linhaCabecalho,
    cabecalhos,
    linhas,
  };

  return {
    sha256: sha256Arquivo(arquivo),
    folhasDisponiveis: nomesFolhas,
    folha,
    cabecalhosDuplicados: duplicados,
  };
}
