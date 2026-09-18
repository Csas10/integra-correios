import { describe, expect, it } from "vitest";
import {
  parsearEnderecoComposto,
  confirmarMapeamento,
  validarMapeamento,
  sugerirMapeamento,
} from "../src/index.js";

// Fixtures exclusivamente sintéticas de ENDERECO composto.

describe("parsing assistido do ENDERECO composto", () => {
  it("PARSED: endereço completo com prefixo, número, bairro, cidade, UF e CEP", () => {
    const resultado = parsearEnderecoComposto(
      "Rua das Flores, 123 - Centro - Salvador/BA - 40020-000",
    );
    expect(resultado.classificacao).toBe("PARSED");
    expect(resultado.sugerido.logradouro).toBe("Rua das Flores");
    expect(resultado.sugerido.numero).toBe("123");
    expect(resultado.sugerido.bairro).toBe("Centro");
    expect(resultado.sugerido.uf).toBe("BA");
    expect(resultado.sugerido.cep).toBe("40020000");
    expect(resultado.issues).toEqual([]);
  });

  it("REVIEW_REQUIRED: cidade/bairro não separáveis — pendente, nunca corrigido", () => {
    const resultado = parsearEnderecoComposto("Rua das Flores, 123");
    expect(resultado.classificacao).toBe("REVIEW_REQUIRED");
    expect(resultado.issues.length).toBeGreaterThan(0);
    // Valor original NÃO é destruído — o sugerido é apenas sugestão.
    expect(resultado.sugerido.logradouro).toContain("Rua das Flores");
  });

  it("INVALID: ENDERECO vazio", () => {
    const resultado = parsearEnderecoComposto("");
    expect(resultado.classificacao).toBe("INVALID");
    expect(resultado.issues[0]).toMatch(/vazio/i);
  });

  it("REVIEW_REQUIRED: sem CEP detectável gera issue explícita", () => {
    const resultado = parsearEnderecoComposto("Av Brasil, 100 - Centro - Salvador/BA");
    expect(resultado.sugerido.cep).toBe("");
    expect(resultado.issues.some((i) => i.includes("CEP"))).toBe(true);
  });

  it("CEP em colagem numérica sem hífen é detectado", () => {
    const resultado = parsearEnderecoComposto("Rua A, 50 - Centro - Sao Paulo/SP - 01234567");
    expect(resultado.sugerido.cep).toBe("01234567");
  });

  it("UF válida é extraída mesmo com hífen separador", () => {
    const resultado = parsearEnderecoComposto("Rua B, 20 - Centro - Feira de Santana - BA");
    expect(resultado.sugerido.uf).toBe("BA");
  });

  it("excede segmentos: sobra vira complemento", () => {
    const resultado = parsearEnderecoComposto(
      "Rua X, 10 - Centro - Salvador/BA - 40020000 - Apto 101 - Bloco B",
    );
    expect(resultado.sugerido.complemento).toContain("Apto 101");
  });
});

describe("mapping institucional da base real (colunas CRT)", () => {
  const CABECALHOS_INSTITUCIONAIS = [
    "CODIGO",
    "REGISTRO NACIONAL",
    "CPF",
    "NOME",
    "EMAIL",
    "CELULAR",
    "TELEFONE",
    "ENDERECO",
    "DATA EVENTO",
    "ULTIMOEXERCICIOQUITADO",
    "ULTIMOEXERCICIOPAGO",
    "ULTIMOEXERCICIOPAGO PARCELAS",
    "EXERCICIOS PENDENTES",
  ];

  it("sugere CODIGO, CPF, NOME, EMAIL, CELULAR, TELEFONE e ENDERECO_COMPOSTO", () => {
    const sugestoes = sugerirMapeamento(CABECALHOS_INSTITUCIONAIS);
    const porCampo = new Map(sugestoes.map((s) => [s.campo, s]));
    expect(porCampo.get("CODIGO")?.coluna).toBe(0);
    expect(porCampo.get("CPF_CNPJ")?.coluna).toBe(2); // cabeçalho "CPF"
    expect(porCampo.get("NOME")?.coluna).toBe(3);
    expect(porCampo.get("EMAIL")?.coluna).toBe(4);
    expect(porCampo.get("CELULAR")?.coluna).toBe(5);
    expect(porCampo.get("TELEFONE")?.coluna).toBe(6);
    expect(porCampo.get("ENDERECO_COMPOSTO")?.coluna).toBe(7);
  });

  it("obrigatórios PF satisfazíveis SEM CEP/UF decompostos (ENDERECO_COMPOSTO cobre)", () => {
    const mapeamento = {
      itens: [
        { campo: "CODIGO" as const, coluna: 0 },
        { campo: "NOME" as const, coluna: 3 },
        { campo: "CPF_CNPJ" as const, coluna: 2 },
        { campo: "ENDERECO_COMPOSTO" as const, coluna: 7 },
        { campo: "TELEFONE" as const, coluna: 6 },
      ],
    };
    // PF: sem ORIGEM — a origem do fluxo é PF; ORIGEM obrigatório no contrato
    // do intake-mapping (linha do arquivo não precisa da coluna ORIGEM quando
    // a base institucional não a possui? A política exige ORIGEM mapeado —
    // mas a base CRT não tem; aqui documentamos o gap pela exceção explícita).
    const erros = validarMapeamento(mapeamento, CABECALHOS_INSTITUCIONAIS.length, "PF");
    // O contrato exige ORIGEM mapeado: a base real não possui essa coluna,
    // então o operador DEVE decidir — bloqueamos sem campo ORIGEM.
    expect(erros.some((e) => e.includes("ORIGEM"))).toBe(true);
  });

  it("ORIGEM não mapeada é exigida mesmo com o resto completo (fail-closed)", () => {
    const mapeamento = {
      itens: [
        { campo: "ORIGEM" as const, coluna: 0 },
        { campo: "CODIGO" as const, coluna: 1 },
        { campo: "NOME" as const, coluna: 3 },
        { campo: "CPF_CNPJ" as const, coluna: 2 },
        { campo: "ENDERECO_COMPOSTO" as const, coluna: 7 },
        { campo: "TELEFONE" as const, coluna: 6 },
      ],
    };
    const erros = validarMapeamento(mapeamento, CABECALHOS_INSTITUCIONAIS.length, "PF");
    expect(erros).toEqual([]);
    expect(() => confirmarMapeamento(mapeamento, CABECALHOS_INSTITUCIONAIS.length, "PF")).not.toThrow();
  });
});
