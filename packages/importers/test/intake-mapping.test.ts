import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  detectarCabecalhosDuplicados,
  lerCsv,
  lerXlsx,
  normalizarCabecalho,
  sha256Arquivo,
} from "../src/index.js";
import {
  aplicarMapeamento,
  criarPerfil,
  sugerirMapeamento,
  validarLinhasPfPj,
  validarMapeamento,
  type Mapeamento,
} from "../src/index.js";
import { cnpjValido, cpfValido } from "@integra-correios/validation";

// Fixtures exclusivamente sintéticas (dados fictícios).

const CABECALHOS = [
  "Origem",
  "Código",
  "Nome",
  "CPF/CNPJ",
  "CEP",
  "Logradouro",
  "Cidade",
  "UF",
  "Telefone",
  "Fantasia",
];

const LINHAS = [
  ["PF", "PF001", "Maria Silva", "529.982.247-25", "01234-567", "Rua A, 10", "São Paulo", "SP", "11999990000", ""],
  ["PJ", "PJ001", "Alpha Ltda", "11.222.333/0001-81", "04567-890", "Av B, 200", "Curitiba", "PR", "1141112222", "Alpha Comércio"],
  // Duplicada (mesma identidade da primeira — deve ser preservada).
  ["PF", "PF001", "Maria Silva", "529.982.247-25", "01234-567", "Rua A, 10", "São Paulo", "SP", "11999990000", ""],
];

const MAPEAMENTO_PADRAO: Mapeamento = {
  itens: [
    { campo: "ORIGEM", coluna: 0 },
    { campo: "CODIGO", coluna: 1 },
    { campo: "NOME", coluna: 2 },
    { campo: "CPF_CNPJ", coluna: 3 },
    { campo: "CEP", coluna: 4 },
    { campo: "LOGRADOURO", coluna: 5 },
    { campo: "CIDADE", coluna: 6 },
    { campo: "UF", coluna: 7 },
    { campo: "TELEFONE", coluna: 8 },
    { campo: "NOME_FANTASIA", coluna: 9 },
  ],
};

function bytesXlsx(linhas: string[][], cabecalhos: string[] = CABECALHOS): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet([cabecalhos, ...linhas]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Planilha1");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
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

  it("rejeita OLE2/CFB renomeado para .xlsx (inspeção estrutural)", () => {
    // Magic OLE2/CFB: D0 CF 11 E0 A1 B1 1A E1 (um .xls renomeado).
    const bytes = new Uint8Array(1024);
    bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
    expect(() => lerXlsx({ nome: "disfarçado.xlsx", bytes })).toThrow(/OLE2\/CFB/);
  });

  it("rejeita OOXML com vbaProject.bin embutido (extensão .xlsx)", () => {
    const bytes = bytesXlsx(LINHAS);
    // Simula um pacote macro-enabled com vbaProject.bin no ZIP.
    const injetado = new Uint8Array(bytes.length + 64);
    injetado.set(bytes, 0);
    injetado.set(new TextEncoder().encode("xl/vbaProject.bin"), bytes.length - 16);
    expect(() => lerXlsx({ nome: "com-vba.xlsx", bytes: injetado })).toThrow(/vbaProject/);
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

  it("rejeita workbook acima do limite de folhas, sem truncar", () => {
    const wb = XLSX.utils.book_new();
    for (let i = 0; i < 21; i++) {
      const ws = XLSX.utils.aoa_to_sheet([["A"], ["1"]]);
      XLSX.utils.book_append_sheet(wb, ws, `F${String(i + 1).padStart(2, "0")}`);
    }
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    expect(() => lerXlsx({ nome: "21folhas.xlsx", bytes })).toThrow(/acima do limite de 20/);
  });
});

describe("linha de cabeçalho", () => {
  it("suporta cabeçalho em linha diferente de 1", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["título descritivo", "", "", "", "", "", "", "", ""],
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
    expect(linha.celulas[3]!.tipoOrigem).toBe("texto");
    expect(linha.celulas[4]!.texto).toBe("01234567");
  });

  it("CSV preserva zeros iniciais igualmente", () => {
    const csv = new TextEncoder().encode("Origem,Código,CPF/CNPJ,CEP\nPF,PF001,06834140000100,01234567\n");
    const resultado = lerCsv({ nome: "f.csv", bytes: csv });
    expect(resultado.folha.linhas[0]!.celulas[2]!.texto).toBe("06834140000100");
    expect(resultado.folha.linhas[0]!.celulas[3]!.texto).toBe("01234567");
  });

  it("célula NUMÉRICA em coluna mapeada para CPF_CNPJ gera alerta fail-closed", () => {
    // CPF armazenado como número no Excel: zero à esquerda perdido (12345678900).
    const ws = XLSX.utils.aoa_to_sheet([
      CABECALHOS,
      ["PF", "PF001", "Fulano", 12345678900, "01234567", "Rua A", "São Paulo", "SP", "11999990000", ""],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Planilha1");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    const leitura = lerXlsx({ nome: "f.xlsx", bytes });
    const aplicado = aplicarMapeamento(leitura.folha, MAPEAMENTO_PADRAO, "PF");
    expect(aplicado.linhas[0]!.alertasNumericos.length).toBe(1);
    expect(aplicado.linhas[0]!.alertasNumericos[0]).toMatch(/CPF_CNPJ/);
  });

  it("célula NUMÉRICA em coluna mapeada para CEP gera alerta fail-closed", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      CABECALHOS,
      ["PF", "PF001", "Fulano", "52998224725", 1234567, "Rua A", "São Paulo", "SP", "11999990000", ""],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Planilha1");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    const leitura = lerXlsx({ nome: "f.xlsx", bytes });
    const aplicado = aplicarMapeamento(leitura.folha, MAPEAMENTO_PADRAO, "PF");
    expect(aplicado.linhas[0]!.alertasNumericos[0]).toMatch(/CEP/);
  });

  it("célula textual nas colunas sensíveis NÃO gera alerta", () => {
    const leitura = lerXlsx({ nome: "f.xlsx", bytes: bytesXlsx(LINHAS) });
    const aplicado = aplicarMapeamento(leitura.folha, MAPEAMENTO_PADRAO, "PF");
    expect(aplicado.linhas[0]!.alertasNumericos).toEqual([]);
  });
});

describe("cabeçalhos duplicados e linhas duplicadas", () => {
  it("detecta cabeçalhos duplicados por forma canônica", () => {
    const bytes = bytesXlsx(LINHAS, [
      "Origem",
      "Origem",
      "Nome",
      "CPF/CNPJ",
      "CEP",
      "Logradouro",
      "Cidade",
      "UF",
      "Telefone",
      "Fantasia",
    ]);
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

  it("mapeamento sem obrigatórios de PF é rejeitado na origem PF", () => {
    const erros = validarMapeamento({ itens: [{ campo: "NOME", coluna: 0 }] }, 9, "PF");
    expect(erros.some((e) => e.includes("PF") && e.includes("ORIGEM"))).toBe(true);
  });

  it("obrigatoriedade é DISTINTA por origem (PF exige TELEFONE, PJ não)", () => {
    const semTelefone: Mapeamento = {
      itens: MAPEAMENTO_PADRAO.itens.filter((i) => i.campo !== "TELEFONE"),
    };
    // PJ: sem TELEFONE mapeado → válido (obrigatórios PJ satisfeitos).
    expect(validarMapeamento(semTelefone, 10, "PJ")).toEqual([]);
    // PF: sem TELEFONE mapeado → erro específico.
    const errosPf = validarMapeamento(semTelefone, 10, "PF");
    expect(errosPf.some((e) => e.includes("TELEFONE"))).toBe(true);
  });

  it("PJ sem NOME_FANTASIA é rejeitado; PF sem NOME_FANTASIA é aceito", () => {
    const semFantasia: Mapeamento = {
      itens: MAPEAMENTO_PADRAO.itens.filter((i) => i.campo !== "NOME_FANTASIA"),
    };
    const errosPj = validarMapeamento(semFantasia, 9, "PJ");
    expect(errosPj.some((e) => e.includes("NOME_FANTASIA"))).toBe(true);
    expect(validarMapeamento(semFantasia, 9, "PF")).toEqual([]);
  });

  it("coluna duplicada no mapeamento é rejeitada", () => {
    const m: Mapeamento = {
      itens: [
        { campo: "ORIGEM", coluna: 0 },
        { campo: "CODIGO", coluna: 0 },
      ],
    };
    expect(() =>
      aplicarMapeamento(
        { nome: "f", linhaCabecalho: 1, cabecalhos: CABECALHOS, linhas: [] },
        m,
        "PF",
      ),
    ).toThrow(/já mapeada/);
  });

  it("aplicação exige confirmação: usa apenas mapeamento validado", () => {
    const bytes = bytesXlsx(LINHAS);
    const leitura = lerXlsx({ nome: "f.xlsx", bytes });
    const aplicado = aplicarMapeamento(leitura.folha, MAPEAMENTO_PADRAO, "PF");
    expect(aplicado.linhas[0]!.valores.CPF_CNPJ).toBe("529.982.247-25");
  });
});

describe("perfil de mapeamento versionado", () => {
  it("cria perfil com origem, folha, linhaCabecalho, nome e versão", () => {
    const perfil = criarPerfil(
      "padrão-consulta",
      1,
      { origem: "PF", folha: "Planilha1", linhaCabecalho: 1 },
      MAPEAMENTO_PADRAO,
    );
    expect(perfil.versao).toBe(1);
    expect(perfil.nome).toBe("padrão-consulta");
    expect(perfil.origem).toBe("PF");
    expect(perfil.folha).toBe("Planilha1");
    expect(perfil.linhaCabecalho).toBe(1);
  });

  it("rejeita versão inválida e origem inválida", () => {
    const ctx = { origem: "PF" as const, folha: null, linhaCabecalho: 1 };
    expect(() => criarPerfil("x", 0, ctx, MAPEAMENTO_PADRAO)).toThrow(/Versão/);
    expect(() =>
      criarPerfil("x", 1, { ...ctx, origem: "XX" as never }, MAPEAMENTO_PADRAO),
    ).toThrow(/origem/);
  });

  it("rejeita linhaCabecalho inválida no perfil", () => {
    const ctx = { origem: "PF" as const, folha: null, linhaCabecalho: 0 };
    expect(() => criarPerfil("x", 1, ctx, MAPEAMENTO_PADRAO)).toThrow(/linhaCabecalho/);
  });
});

describe("validação PF/PJ", () => {
  it("aceita linha PF válida no fluxo PF", () => {
    const bytes = bytesXlsx(LINHAS);
    const leitura = lerXlsx({ nome: "f.xlsx", bytes });
    const aplicado = aplicarMapeamento(leitura.folha, MAPEAMENTO_PADRAO, "PF");
    const resultados = validarLinhasPfPj(aplicado.linhas, "PF", cpfValido, cnpjValido);
    expect(resultados[0]!.valido).toBe(true);
  });

  it("valida CNPJ no fluxo PJ e CPF no fluxo PF (validadores distintos)", () => {
    const bytes = bytesXlsx(LINHAS);
    const leitura = lerXlsx({ nome: "f.xlsx", bytes });
    const aplicado = aplicarMapeamento(leitura.folha, MAPEAMENTO_PADRAO, "PJ");
    const resultados = validarLinhasPfPj(aplicado.linhas, "PJ", cpfValido, cnpjValido);
    expect(resultados[1]!.valido).toBe(true);
    // CPF (11 dígitos) na linha do fluxo PJ falha por tamanho (esperado 14).
    expect(resultados[0]!.valido).toBe(false);
    expect(resultados[0]!.erros.some((e) => e.includes("14"))).toBe(true);
  });

  it("rejeita origem divergente do fluxo, CEP curto e documento vazio", () => {
    const linhas = [
      {
        numero: 2,
        valores: { ORIGEM: "XX", CODIGO: "1", NOME: "A", CPF_CNPJ: "", CEP: "123" },
        alertasNumericos: [],
      },
    ];
    const resultados = validarLinhasPfPj(linhas, "PF", cpfValido, cnpjValido);
    expect(resultados[0]!.valido).toBe(false);
    expect(resultados[0]!.erros.length).toBeGreaterThanOrEqual(3);
  });

  it("normalizarCabecalho remove acentos e uppercase", () => {
    expect(normalizarCabecalho("  Código  ")).toBe("CODIGO");
  });
});

describe("CSV RFC 4180: campos quoted com quebra de linha", () => {
  it("suporta campo quoted com quebra de linha interna", () => {
    const csv = new TextEncoder().encode(
      'Origem,Código,Logradouro,CEP\nPF,PF001,"Rua A\nComplemento: fundos",01234567\n',
    );
    const resultado = lerCsv({ nome: "multiline.csv", bytes: csv });
    expect(resultado.folha.linhas).toHaveLength(1);
    const logradouro = resultado.folha.linhas[0]!.celulas[2]!.texto;
    expect(logradouro).toBe("Rua A\nComplemento: fundos");
    expect(resultado.folha.linhas[0]!.celulas[3]!.texto).toBe("01234567");
  });

  it("preserva aspas duplicadas escapadas e número da linha física correta", () => {
    const csv = new TextEncoder().encode('a,b\n"ele disse ""oi""",2\nx,3\n');
    const resultado = lerCsv({ nome: "aspas.csv", bytes: csv });
    expect(resultado.folha.linhas[0]!.celulas[0]!.texto).toBe('ele disse "oi"');
    expect(resultado.folha.linhas[1]!.numero).toBe(3);
  });

  it("trata CRLF e campo quoted com CRLF interno", () => {
    const csv = new TextEncoder().encode('a,b\r\n"linha1\r\nlinha2",fim\r\n');
    const resultado = lerCsv({ nome: "crlf.csv", bytes: csv });
    expect(resultado.folha.linhas).toHaveLength(1);
    expect(resultado.folha.linhas[0]!.celulas[0]!.texto).toBe("linha1\r\nlinha2");
  });
});
