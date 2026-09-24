import { describe, expect, it } from "vitest";
import {
  analisarCampanhaAtualizacaoPf,
  PfUpdateCampaignImportError,
  type FolhaExtraida,
} from "../src/index.js";

function folha(cabecalhos: string[], rows: string[][]): FolhaExtraida {
  return {
    nome: "Teste",
    linhaCabecalho: 1,
    cabecalhos,
    linhas: rows.map((values, index) => ({
      numero: index + 2,
      celulas: values.map((texto, coluna) => ({
        coluna,
        texto,
        tipoOrigem: "texto" as const,
      })),
    })),
  };
}

describe("Campanha PF — importação e pré-voo", () => {
  it("normaliza, preserva original e põe duplicidades em quarentena", () => {
    const report = analisarCampanhaAtualizacaoPf(
      {
        sha256: "a".repeat(64),
        folha: folha(
          ["REGISTRO", "NOME", "E- MAIL"],
          [
            ["1001", "  Ana\nSilva  ", " ANA@\nEXEMPLO.COM "],
            ["1002", "Bruna Souza", "ana@example.com"],
            ["1003", "Carlos Lima", "email-invalido"],
            ["1004", "Daniel Costa", "daniel@example.com"],
          ],
        ),
      },
      { colunaIdentificadorInstitucional: "REGISTRO" },
    );

    expect(report.total_registros).toBe(4);
    expect(report.aptos).toBe(1);
    expect(report.bloqueados).toBe(3);
    expect(report.duplicidades_email).toHaveLength(1);
    expect(report.duplicidades_email[0]?.linhas).toEqual([2, 3]);

    const ana = report.registros[0]!;
    expect(ana.nome_exibicao).toBe("Ana Silva");
    expect(ana.email).toBe(" ANA@\nEXEMPLO.COM ");
    expect(ana.email_normalizado).toBe("ana@example.com");
    expect(ana.motivo_bloqueio).toContain("EMAIL_DUPLICADO");
    expect(ana.normalizacoes_aplicadas).toEqual(
      expect.arrayContaining(["NOME_ESPACOS", "EMAIL_ESPACOS", "EMAIL_CASE"]),
    );
    expect(report.registros[2]?.motivo_bloqueio).toContain("EMAIL_INVALIDO");
    expect(report.registros[3]?.status_validacao).toBe("APTO");
  });

  it("bloqueia identificador institucional ausente ou duplicado", () => {
    const report = analisarCampanhaAtualizacaoPf(
      {
        sha256: "b".repeat(64),
        folha: folha(
          ["PROFISSIONAL_ID", "NOME", "EMAIL"],
          [
            ["", "Sem Id", "semid@example.com"],
            ["ABC", "Pessoa Um", "um@example.com"],
            ["ABC", "Pessoa Dois", "dois@example.com"],
          ],
        ),
      },
      { colunaIdentificadorInstitucional: "PROFISSIONAL_ID" },
    );

    expect(report.aptos).toBe(0);
    expect(report.registros[0]?.motivo_bloqueio).toContain("IDENTIFICADOR_INSTITUCIONAL_AUSENTE");
    expect(report.registros[1]?.motivo_bloqueio).toContain("IDENTIFICADOR_INSTITUCIONAL_DUPLICADO");
    expect(report.registros[2]?.motivo_bloqueio).toContain("IDENTIFICADOR_INSTITUCIONAL_DUPLICADO");
  });

  it("não aceita nome ou e-mail como identidade definitiva", () => {
    expect(() =>
      analisarCampanhaAtualizacaoPf(
        {
          sha256: "c".repeat(64),
          folha: folha(["NOME", "E-MAIL"], [["Ana", "ana@example.com"]]),
        },
        { colunaIdentificadorInstitucional: "NOME" },
      ),
    ).toThrow(PfUpdateCampaignImportError);
  });
});
