import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { lerCsv, lerXlsx, normalizarCabecalho, detectarCabecalhosDuplicados, sha256Arquivo } from "../src/index.js";
import {
  aplicarMapeamento,
  criarPerfil,
  sugerirMapeamento,
  validarLinhasPfPj,
  validarMapeamento,
} from "../src/index.js";
import { cpfValido, cnpjValido } from "@integra-correios/validation";

// Fixtures exclusivamente sintéticas (dados fictícios).

const CABECALHOS = ["Origem", "Código", "Nome", "CPF/CNPJ", "CEP", "Logradouro", "Cidade", "UF"];

function bytesXlsx(linhas: string[][], cabecalhos: string[] = CABECALHOS): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet([cabecalhos, ...linhas]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Planilha1");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

const LINHAS = [
  ["PF", "PF001", "Maria Silva", "529.982.247-25", "01234-567", "Rua A, 10", "São Paulo", "SP"],
  ["PJ", "PJ001", "Alpha Ltda", "11.222.333/0001-81", "04567-890", "Av B, 200", "Curitiba", "PR"],
  ["PF", "PF001", "Maria Silva", "529.982.247-25", "01234-567", "Rua A, 10", "São Paulo", "SP"], // duplicada
];

function mapeamentoPadrao() {
  return {
    itens: [
      { campo: "ORIGEM", coluna: 0 },
      { campo: "CODIGO", coluna: 1 },
      { campo: "NOME", coluna: 2 },
      { campo: "CPF_CNPJ", coluna: 3 },
      { campo: "CEP", coluna: 4 },
      { campo: "LOGRADOURO", coluna: 5 },
      { campo: "CIDADE", coluna: 6 },
      { campo: "UF", coluna: 7 },
    ] as const,
  };
}

function validarDocumento(doc: string): boolean {
  if (doc.length === 11) return cpfValido(doc);
  if (doc.length === 14) return cnpjValido(doc);
  return false;
}

describe("sha256 do arquivo original", () => {
  it("gera hash hex de 64 caracteres", () => {
    const arquivo = { nome: "entrada.xlsx", bytes: bytesXlsx(LINHAS) };
    expect(sha256Arquivo(arquivo)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hash difere quando o conteúdo muda", () => {
    const a = { nome: "a.csv", bytes: new TextEncoder().encode("a,b\n1,2\n") };
    const b = { nome: "a.csv", bytes: new TextEncoder().encode("a,b\n1,3\n") };
    expect(sha256Arquivo(a)).not.toBe(sha256Arquivo(b));
  });
});

describe("rejeição de conteúdo perigoso", () => {
  it("rejeita extensões de macro/executável", () => {
    const arquivo = { nome: "planilha.xlsm", bytes: new Uint8Array(10) };
    expect(() => lerXlsx(arquivo)).toThrow(/macro/i);
  });

  it("rejeita arquivo acima do limite de tamanho", () => {
    const arquivo = { nome: "grande.csv", bytes: new Uint8Array(21 * 1024 * 1024) };
    expect(() => lerCsv(arquivo)).toThrow(/limite/i);
  });
});

describe("seleção de folha", () => {
  it("rejeita multi-folha sem seleção explícita", () => {
    const ws1 = XLSX.utils.aoa_to_sheet([CABECALHOS, ...LINHAS]);
    const ws2 = XLSX.utils.aoa_to_sheet([["A"], ["1"]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, "Dados");
    XLSX.utils.book_append_sheet(wb, ws2, "Outros");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    expect(() => lerXlsx({ nome: "multi.xlsx", bytes })).toThrow(/Selecione uma explicitamente/);
  });

  it("seleciona folha explicitamente (case-insensitive)", () => {
    const ws1 = XLSX.utils.aoa_to_sheet([CABECALHOS, ...LINHAS]);
    const ws2 = XLSX.utils.aoa_to_sheet([["A"], ["1"]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, "Dados");
    XLSX.utils.book_append_sheet(wb, ws2, "Outros");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    const resultado = lerXlsx({ nome: "multi.xlsx", bytes }, { folha: "dados" });
    expect(resultado.folha.nome).toBe("Dados");
  });
});

describe("linha de cabeçalho", () => {
  it("suporta cabeçalho em linha diferente de 1", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["título descritivo", "", "", "", "", "", "", ""],
      CABECALHOS,
      ...LINHAS,
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Planilha1");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    const resultado = lerXlsx({ nome: "f.xlsx", bytes }, { linhaCabecalho: 2 });
    expect(resultado.folha.cabecalhos[0]).toBe("Origem");
  });

  it("rejeita linhaCabecalho inválida", () => {
    const bytes = bytesXlsx(LINHAS);
    expect(() => lerXlsx({ nome: "f.xlsx", bytes }, { linhaCabecalho: 0 })).toThrow(/inteiro/);
  });
});

describe("preservação de tipos textuais", () => {
  it("preserva zeros iniciais de CPF/CNPJ/CEP como string", () => {
    const linhas = [["PF", "PF001", "Fulano", "06834140000100", "01234567"]];
    const bytes = bytesXlsx(linhas, ["Origem", "Código", "Nome", "CPF/CNPJ", "CEP"]);
    const resultado = lerXlsx({ nome: "f.xlsx", bytes });
    const linha = resultado.folha.linhas[0]!;
    expect(linha.celulas[3]!.texto).toBe("06834140000100");
    expect(linha.celulas[4]!.texto).toBe("01234567");
  });

  it("CSV preserva zeros iniciais igualmente", () => {
    const csv = new TextEncoder().encode("Origem,Código,CPF/CNPJ,CEP\nPF,PF001,06834140000100,01234567\n");
    const resultado = lerCsv({ nome: "f.csv", bytes: csv });
    expect(resultado.folha.linhas[0]!.celulas[2]!.texto).toBe("06834140000100");
    expect(resultado.folha.linhas[0]!.celulas[3]!.texto).toBe("01234567");
  });
});

describe("cabeçalhos duplicados e linhas duplicadas", () => {
  it("detecta cabeçalhos duplicados por forma canônica", () => {
    const bytes = bytesXlsx(LINHAS, ["Origem", "Origem", "Nome", "CPF/CNPJ", "CEP", "Logradouro", "Cidade", "UF"]);
    const resultado = lerXlsx({ nome: "f.xlsx", bytes });
    expect(resultado.cabecalhosDuplicados).toEqual(["Origem"]);
  });

  it("detecta duplicados case-insensitive e com acento", () => {
    const dup = detectarCabecalhosDuplicados(["Código", "CODIGO", "Nome"]);
    expect(dup).toEqual(["Código"]);
  });

  it("preserva linhas duplicadas na extração", () => {
    const bytes = bytesXlsx(LINHAS);
    const resultado = lerXlsx({ nome: "f.xlsx", bytes });
    expect(resultado.folha.linhas).toHaveLength(3);
    expect(resultado.folha.linhas[0]!.celulas[1]!.texto).toBe("PF001");
    expect(resultado.folha.linhas[2]!.celulas[1]!.texto).toBe("PF001");
  });
});

describe("sugestão e confirmação de mapeamento", () => {
  it("sugere mapeamento por aliases canônicos", () => {
    const sugestoes = sugerirMapeamento(CABECALHOS);
    const origem = sugestoes.find((s) => s.campo === "ORIGEM")!;
    expect(origem.coluna).toBe(0);
    const doc = sugestoes.find((s) => s.campo === "CPF_CNPJ")!;
    expect(doc.coluna).toBe(3);
  });

  it("mapeamento sem campo obrigatório é rejeitado", () => {
    const erros = validarMapeamento({ itens: [{ campo: "NOME", coluna: 0 }] }, 8);
    expect(erros.some((e) => e.includes("ORIGEM"))).toBe(true);
  });

  it("coluna duplicada no mapeamento é rejeitada", () => {
    const m = { itens: [{ campo: "ORIGEM", coluna: 0 }, { campo: "CODIGO", coluna: 0 }] };
    expect(() => aplicarMapeamento({ nome: "f", linhaCabecalho: 1, cabecalhos: CABECALHOS, linhas: [] }, m as never)).toThrow(/já mapeada/);
  });

  it("aplicação exige confirmação: usa apenas mapeamento validado", () => {
    const bytes = bytesXlsx(LINHAS);
    const leitura = lerXlsx({ nome: "f.xlsx", bytes });
    const m = mapeamentoPadrao() as unknown as Parameters<typeof aplicarMapeamento>[1];
    const aplicado = aplicarMapeamento(leitura.folha, m);
    expect(aplicado.linhas[0]!.valores.CPF_CNPJ).toBe("529.982.247-25");
  });
});

describe("perfil de mapeamento versionado", () => {
  it("cria perfil com nome e versão", () => {
    const perfil = criarPerfil("padrão-consulta", 1, mapeamentoPadrao() as never);
    expect(perfil.versao).toBe(1);
    expect(perfil.nome).toBe("padrão-consulta");
  });

  it("rejeita versão inválida", () => {
    expect(() => criarPerfil("x", 0, mapeamentoPadrao() as never)).toThrow(/Versão/);
  });
});

describe("validação PF/PJ", () => {
  it("aceita linha PF e PJ válidas", () => {
    const bytes = bytesXlsx(LINHAS);
    const leitura = lerXlsx({ nome: "f.xlsx", bytes });
    const aplicado = aplicarMapeamento(leitura.folha, mapeamentoPadrao() as never);
    const resultados = validarLinhasPfPj(aplicado.linhas, validarDocumento);
    expect(resultados[0]!.valido).toBe(true);
    expect(resultados[1]!.valido).toBe(true);
  });

  it("rejeita origem inválida, CEP curto e documento inválido", () => {
    const linhas = [
      { numero: 2, valores: { ORIGEM: "XX", CODIGO: "1", NOME: "A", CPF_CNPJ: "11111111111", CEP: "123" } },
    ];
    const resultados = validarLinhasPfPj(linhas, validarDocumento);
    expect(resultados[0]!.valido).toBe(false);
    expect(resultados[0]!.erros.length).toBeGreaterThanOrEqual(3);
  });

  it("normalizarCabecalho remove acentos e uppercase", () => {
    expect(normalizarCabecalho("  Código  ")).toBe("CODIGO");
  });
});
