/**
 * Regressões do REAL_FILE_PREFLIGHT — contrato PF aprovado:
 *
 *  - Requisitos de APTO_CONTATO: NOME + CPF válido + E-MAIL válido + TELEFONE
 *    válido (e sem duplicidade no arquivo). Endereço NÃO é requisito de
 *    contato.
 *  - Endereço ausente → NOT_PROVIDED (sem pendência) e NÃO bloqueia contato.
 *  - Endereço incompleto → REVIEW_REQUIRED, alerta preservado ao operador e
 *    NÃO bloqueia contato (bloqueia somente a progressão postal posterior,
 *    via validarCadastroPf → APTO_PREPOSTAGEM).
 *  - Endereço individual completo → composição automática (PARSED).
 *  - CPF/telefone/e-mail inválidos → NÃO apto ao contato.
 *
 * Todas as fixtures são sintéticas (CPFs válidos matematicamente, e-mails
 * example.test) — nenhum dado institucional real.
 */
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { executarPreflight } from "../src/intake.js";

const CPF_SINTETICO_A = ["529", "982", "247", "25"].join("");
const CPF_SINTETICO_B = ["168", "995", "350", "09"].join("");

function bytesParaLinhas(linhas: unknown[][]): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "PF");
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

function preflightDe(linhas: unknown[][]) {
  return executarPreflight({
    nomeArquivo: "pf-regressao-endereco.xlsx",
    bytes: bytesParaLinhas(linhas),
    folha: "PF",
    mapeamento: [
      { campo: "CPF_CNPJ" as const, coluna: 0 },
      { campo: "NOME" as const, coluna: 1 },
      { campo: "EMAIL" as const, coluna: 2 },
      { campo: "TELEFONE" as const, coluna: 3 },
      { campo: "ENDERECO_COMPOSTO" as const, coluna: 4 },
    ],
  });
}

describe("REAL_FILE_PREFLIGHT — endereço não bloqueia APTO_CONTATO (contrato PF)", () => {
  it("1. contato válido sem qualquer endereço: válida, NOT_PROVIDED, APTO_CONTATO", () => {
    const resumo = preflightDe([
      ["CPF", "NOME", "EMAIL", "TELEFONE", "ENDERECO"],
      [CPF_SINTETICO_A, "Pessoa Sintetica A", "pessoa-a@example.test", "7133330001", ""],
    ]);

    expect(resumo.total).toBe(1);
    expect(resumo.aptosContato).toBe(1);
    const registro = resumo.registros[0];
    expect(registro?.aptoContato).toBe(true);
    expect(registro?.issues).toEqual([]);
    expect(registro?.endereco.classificacao).toBe("NOT_PROVIDED");
  });

  it("2. endereço parcialmente preenchido: REVIEW_REQUIRED com alerta preservado e APTO_CONTATO", () => {
    // Endereço composto sem CEP/UF detectáveis → decomposição assistida
    // incompleta (REVIEW_REQUIRED), porém contato íntegro.
    const resumo = preflightDe([
      ["CPF", "NOME", "EMAIL", "TELEFONE", "ENDERECO"],
      [
        CPF_SINTETICO_A,
        "Pessoa Sintetica B",
        "pessoa-b@example.test",
        "7133330002",
        "Rua Sem Cep, 45 - Bairro Alto",
      ],
    ]);

    expect(resumo.total).toBe(1);
    expect(resumo.enderecoRequerRevisao).toBe(1);
    const registro = resumo.registros[0];
    expect(registro?.endereco.classificacao).toBe("REVIEW_REQUIRED");
    expect(registro?.issues).toContain("Endereço requer revisão (decomposição assistida incompleta).");
    expect(registro?.aptoContato).toBe(true);
    expect(resumo.aptosContato).toBe(1);
  });

  it("3. endereço individual completo: composição automática (PARSED) e APTO_CONTATO", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["CPF", "NOME", "EMAIL", "TELEFONE", "LOGRADOURO", "NUMERO", "BAIRRO", "CIDADE", "UF", "CEP"],
      [
        CPF_SINTETICO_A,
        "Pessoa Sintetica C",
        "pessoa-c@example.test",
        "7133330003",
        "Rua de Teste",
        "10",
        "Centro",
        "Salvador",
        "BA",
        "40020000",
      ],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "PF");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

    const resumo = executarPreflight({
      nomeArquivo: "pf-regressao-endereco-individual.xlsx",
      bytes,
      folha: "PF",
      mapeamento: [
        { campo: "CPF_CNPJ" as const, coluna: 0 },
        { campo: "NOME" as const, coluna: 1 },
        { campo: "EMAIL" as const, coluna: 2 },
        { campo: "TELEFONE" as const, coluna: 3 },
        { campo: "LOGRADOURO" as const, coluna: 4 },
        { campo: "NUMERO" as const, coluna: 5 },
        { campo: "BAIRRO" as const, coluna: 6 },
        { campo: "CIDADE" as const, coluna: 7 },
        { campo: "UF" as const, coluna: 8 },
        { campo: "CEP" as const, coluna: 9 },
      ],
    });

    expect(resumo.aptosContato).toBe(1);
    const registro = resumo.registros[0];
    expect(registro?.endereco.classificacao).toBe("PARSED");
    expect(registro?.aptoContato).toBe(true);
  });

  it("4. telefone inválido ou CPF inválido: NÃO apto ao contato", () => {
    const resumo = preflightDe([
      ["CPF", "NOME", "EMAIL", "TELEFONE", "ENDERECO"],
      // Telefone com dígitos insuficientes.
      [CPF_SINTETICO_A, "Pessoa Sem Telefone", "sem-telefone@example.test", "999", ""],
      // Telefone repetido (fixture sintética reconhecível).
      [CPF_SINTETICO_B, "Pessoa Telefone Repetido", "telefone-repetido@example.test", "11111111111", ""],
      // CPF matematicamente inválido.
      ["12345678900", "Pessoa Cpf Invalido", "cpf-invalido@example.test", "7133330004", ""],
    ]);

    expect(resumo.total).toBe(3);
    expect(resumo.aptosContato).toBe(0);
    for (const registro of resumo.registros) {
      expect(registro?.aptoContato).toBe(false);
    }
    expect(resumo.cpfInvalido).toBe(1);
  });
});
