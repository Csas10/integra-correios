import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  detectarCabecalhosDuplicados,
  confirmarMapeamento,
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
  "Endereço",
];

const LINHAS = [
  // Documentos sintéticos sem máscara (a política de fixtures veda PII
  // formatado; o que importa para o teste é o tipo String preservado).
  ["PF", "PF001", "Maria Silva", "52998224725", "01234567", "Rua A, 10", "São Paulo", "SP", "11999990000", ""],
  ["PJ", "PJ001", "Alpha Ltda", "11222333000181", "04567890", "Av B, 200", "Curitiba", "PR", "1141112222", "Alpha Comércio"],
  // Duplicada (mesma identidade da primeira — deve ser preservada).
  ["PF", "PF001", "Maria Silva", "52998224725", "01234567", "Rua A, 10", "São Paulo", "SP", "11999990000", ""],
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
    { campo: "ENDERECO_COMPOSTO", coluna: 10 },
  ],
};

function aplicarPadrao(
  folha: ReturnType<typeof lerXlsx>["folha"],
  origem: "PF" | "PJ",
) {
  const confirmado = confirmarMapeamento(
    MAPEAMENTO_PADRAO,
    folha.cabecalhos.length,
    origem,
  );
  return aplicarMapeamento(folha, confirmado);
}

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
    expect(() => lerXlsx(arquivo)).toThrow(/somente.*\.xlsx/i);
  });

  it.each(["planilha.csv", "planilha.txt", "planilha.xlsx.exe"])(
    "aceita somente extensão .xlsx: %s",
    (nome) => {
      expect(() => lerXlsx({ nome, bytes: bytesXlsx(LINHAS) })).toThrow(/somente.*\.xlsx/i);
    },
  );

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

  it("detecta vbaProject.bin depois do primeiro MiB", () => {
    const bytes = bytesXlsx(LINHAS);
    const injetado = new Uint8Array(1_200_000);
    injetado.set(bytes, 0);
    injetado.set(new TextEncoder().encode("xl/vbaProject.bin"), 1_150_000);
    expect(() => lerXlsx({ nome: "vba-tardio.xlsx", bytes: injetado }))
      .toThrow(/vbaProject/);
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

  it("rejeita linhaCabecalho fora do range real da worksheet", () => {
    const bytes = bytesXlsx(LINHAS);
    expect(() => lerXlsx({ nome: "f.xlsx", bytes }, { linhaCabecalho: 99 }))
      .toThrow(/fora do intervalo real/);

    const ws: XLSX.WorkSheet = {
      A3: { t: "s", v: "Origem" },
      B3: { t: "s", v: "Código" },
      A4: { t: "s", v: "PF" },
      B4: { t: "s", v: "PF001" },
      "!ref": "A3:B4",
    };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Planilha1");
    const deslocado = new Uint8Array(
      XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
    );
    expect(() => lerXlsx({ nome: "f.xlsx", bytes: deslocado }, { linhaCabecalho: 1 }))
      .toThrow(/fora do intervalo real/);
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
    // CPF válido armazenado como número ainda é bloqueado por risco de perda de zeros.
    const ws = XLSX.utils.aoa_to_sheet([
      CABECALHOS,
      ["PF", "PF001", "Fulano", 52998224725, "01234567", "Rua A", "São Paulo", "SP", "11999990000", ""],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Planilha1");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    const leitura = lerXlsx({ nome: "f.xlsx", bytes });
    const aplicado = aplicarPadrao(leitura.folha, "PF");
    expect(aplicado.linhas[0]!.alertasNumericos.length).toBe(1);
    expect(aplicado.linhas[0]!.alertasNumericos[0]).toMatch(/CPF_CNPJ/);
    const validacao = validarLinhasPfPj(aplicado.linhas, "PF", cpfValido, cnpjValido);
    expect(validacao[0]!.valido).toBe(false);
    expect(validacao[0]!.erros).toEqual(
      expect.arrayContaining([expect.stringMatching(/Bloqueio por célula numérica.*CPF_CNPJ/)]),
    );
  });

  it("célula NUMÉRICA em coluna mapeada para CEP gera alerta fail-closed", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      CABECALHOS,
      ["PF", "PF001", "Fulano", "52998224725", 12345678, "Rua A", "São Paulo", "SP", "11999990000", ""],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Planilha1");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    const leitura = lerXlsx({ nome: "f.xlsx", bytes });
    const aplicado = aplicarPadrao(leitura.folha, "PF");
    expect(aplicado.linhas[0]!.alertasNumericos[0]).toMatch(/CEP/);
    const validacao = validarLinhasPfPj(aplicado.linhas, "PF", cpfValido, cnpjValido);
    expect(validacao[0]!.valido).toBe(false);
    expect(validacao[0]!.erros).toEqual(
      expect.arrayContaining([expect.stringMatching(/Bloqueio por célula numérica.*CEP/)]),
    );
  });

  it("célula textual nas colunas sensíveis NÃO gera alerta", () => {
    const leitura = lerXlsx({ nome: "f.xlsx", bytes: bytesXlsx(LINHAS) });
    const aplicado = aplicarPadrao(leitura.folha, "PF");
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
    expect(erros.some((e) => e.includes("PF") && e.includes("CPF_CNPJ"))).toBe(true);
    expect(erros.some((e) => e.includes("TELEFONE"))).toBe(true);
    expect(erros.some((e) => e.includes("CODIGO"))).toBe(false);
    expect(erros.some((e) => e.includes("ENDERECO_COMPOSTO"))).toBe(false);
    expect(erros.some((e) => e.includes("ORIGEM"))).toBe(false);
  });

  it("PF aceita mapping sem CODIGO e ENDERECO_COMPOSTO", () => {
    const mapeamento: Mapeamento = {
      itens: [
        { campo: "NOME", coluna: 0 },
        { campo: "CPF_CNPJ", coluna: 1 },
        { campo: "TELEFONE", coluna: 2 },
      ],
    };
    expect(validarMapeamento(mapeamento, 3, "PF")).toEqual([]);
    expect(() => confirmarMapeamento(mapeamento, 3, "PF")).not.toThrow();
  });

  it("obrigatoriedade é DISTINTA por origem (PF exige TELEFONE, PJ não)", () => {
    const semTelefone: Mapeamento = {
      itens: MAPEAMENTO_PADRAO.itens.filter((i) => i.campo !== "TELEFONE"),
    };
    // PJ: sem TELEFONE mapeado → válido (obrigatórios PJ satisfeitos).
    expect(validarMapeamento(semTelefone, CABECALHOS.length, "PJ")).toEqual([]);
    // PF: sem TELEFONE mapeado → erro específico.
    const errosPf = validarMapeamento(semTelefone, CABECALHOS.length, "PF");
    expect(errosPf.some((e) => e.includes("TELEFONE"))).toBe(true);
  });

  it("PJ sem NOME_FANTASIA é rejeitado; PF sem NOME_FANTASIA é aceito", () => {
    const semFantasia: Mapeamento = {
      itens: MAPEAMENTO_PADRAO.itens.filter((i) => i.campo !== "NOME_FANTASIA"),
    };
    const errosPj = validarMapeamento(semFantasia, CABECALHOS.length, "PJ");
    expect(errosPj.some((e) => e.includes("NOME_FANTASIA"))).toBe(true);
    expect(validarMapeamento(semFantasia, CABECALHOS.length, "PF")).toEqual([]);
  });

  it("coluna duplicada no mapeamento é rejeitada", () => {
    const m: Mapeamento = {
      itens: [
        { campo: "ORIGEM", coluna: 0 },
        { campo: "CODIGO", coluna: 0 },
      ],
    };
    expect(() => confirmarMapeamento(m, CABECALHOS.length, "PF"))
      .toThrow(/já mapeada/);
  });

  it("aplicação aceita somente MapeamentoConfirmado opaco", () => {
    const bytes = bytesXlsx(LINHAS);
    const leitura = lerXlsx({ nome: "f.xlsx", bytes });
    const confirmado = confirmarMapeamento(
      MAPEAMENTO_PADRAO,
      leitura.folha.cabecalhos.length,
      "PF",
    );
    const aplicado = aplicarMapeamento(leitura.folha, confirmado);
    expect(aplicado.linhas[0]!.valores.CPF_CNPJ).toBe("52998224725");
    expect(() =>
      aplicarMapeamento(
        leitura.folha,
        // @ts-expect-error Um Mapeamento estrutural não cruza a fronteira confirmada.
        MAPEAMENTO_PADRAO,
      ),
    ).toThrow(/não foi confirmado/);
  });

  it("rejeita reaplicação do confirmado quando o layout muda", () => {
    const confirmado = confirmarMapeamento(MAPEAMENTO_PADRAO, CABECALHOS.length, "PF");
    expect(() => aplicarMapeamento(
      { nome: "f", linhaCabecalho: 1, cabecalhos: CABECALHOS.slice(0, -1), linhas: [] },
      confirmado,
    )    ).toThrow(/confirmado para 11 colunas/);
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
    const aplicado = aplicarPadrao(leitura.folha, "PF");
    const resultados = validarLinhasPfPj(aplicado.linhas, "PF", cpfValido, cnpjValido);
    expect(resultados[0]!.valido).toBe(true);
  });

  it("valida CNPJ no fluxo PJ e CPF no fluxo PF (validadores distintos)", () => {
    const bytes = bytesXlsx(LINHAS);
    const leitura = lerXlsx({ nome: "f.xlsx", bytes });
    const aplicado = aplicarPadrao(leitura.folha, "PJ");
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

  it("rejeita EOF com campo quoted não fechado", () => {
    const csv = new TextEncoder().encode('nome,endereco\nJoão,"Rua A\n');
    expect(() => lerCsv({ nome: "aspas-abertas.csv", bytes: csv }))
      .toThrow(/não foi fechado antes do fim do arquivo/);
  });

  it("interrompe durante o parsing ao exceder maxLinhas", () => {
    const csv = new TextEncoder().encode("a,b\n1,2\n3,4\n");
    expect(() => lerCsv(
      { nome: "linhas.csv", bytes: csv },
      { limites: { maxLinhas: 1 } },
    )).toThrow(/limite de 1 linhas.*durante o parsing/);
  });

  it("interrompe durante o parsing ao exceder maxColunas", () => {
    const csv = new TextEncoder().encode("a,b,c\n1,2,3\n");
    expect(() => lerCsv(
      { nome: "colunas.csv", bytes: csv },
      { limites: { maxColunas: 2 } },
    )).toThrow(/limite de 2 colunas.*durante o parsing/);
  });
});
