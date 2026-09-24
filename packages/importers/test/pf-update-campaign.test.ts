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
            ["1001", "  Ana\nSilva  ", " ANA@EXEMPLO.COM "],
            ["1002", "Bruna Souza", "ana@exemplo.com"],
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
    expect(ana.email).toBe(" ANA@EXEMPLO.COM ");
    expect(ana.email_normalizado).toBe("ana@exemplo.com");
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

  it("não corrige silenciosamente espaços internos no e-mail", () => {
    const report = analisarCampanhaAtualizacaoPf(
      {
        sha256: "e".repeat(64),
        folha: folha(
          ["REGISTRO", "NOME", "EMAIL"],
          [
            ["3001", "João Silva", "joao silva@gmail.com"],
            ["3002", "Maria Souza", " maria.souza@gmail.com "],
          ],
        ),
      },
      { colunaIdentificadorInstitucional: "REGISTRO" },
    );

    expect(report.registros[0]?.email).toBe("joao silva@gmail.com");
    expect(report.registros[0]?.email_normalizado).toBe("joao silva@gmail.com");
    expect(report.registros[0]?.motivo_bloqueio).toContain("EMAIL_INVALIDO");
    expect(report.registros[0]?.status_validacao).toBe("BLOQUEADO");

    expect(report.registros[1]?.email_normalizado).toBe("maria.souza@gmail.com");
    expect(report.registros[1]?.status_validacao).toBe("APTO");
    expect(report.registros[1]?.normalizacoes_aplicadas).toContain("EMAIL_ESPACOS");
  });

  it("bloqueia local-part com ponto inicial, final ou consecutivo", () => {
    const report = analisarCampanhaAtualizacaoPf(
      {
        sha256: "d".repeat(64),
        folha: folha(
          ["REGISTRO", "NOME", "EMAIL"],
          [
            ["2001", "Ponto Inicial", ".inicio@example.com"],
            ["2002", "Ponto Final", "final.@example.com"],
            ["2003", "Ponto Duplo", "a..b@example.com"],
            ["2004", "Valido", "a.b@example.com"],
          ],
        ),
      },
      { colunaIdentificadorInstitucional: "REGISTRO" },
    );

    expect(report.registros[0]?.motivo_bloqueio).toContain("EMAIL_INVALIDO");
    expect(report.registros[1]?.motivo_bloqueio).toContain("EMAIL_INVALIDO");
    expect(report.registros[2]?.motivo_bloqueio).toContain("EMAIL_INVALIDO");
    expect(report.registros[3]?.status_validacao).toBe("APTO");
  });

  it("respeita limite DNS de 63 bytes por rótulo de domínio", () => {
    const label63 = "a".repeat(63);
    const label64 = "b".repeat(64);
    const report = analisarCampanhaAtualizacaoPf(
      {
        sha256: "f".repeat(64),
        folha: folha(
          ["REGISTRO", "NOME", "EMAIL"],
          [
            ["4001", "Limite Válido", `ana@${label63}.com`],
            ["4002", "Limite Inválido", `bia@${label64}.com`],
          ],
        ),
      },
      { colunaIdentificadorInstitucional: "REGISTRO" },
    );

    expect(report.registros[0]?.status_validacao).toBe("APTO");
    expect(report.registros[0]?.motivo_bloqueio).not.toContain("EMAIL_INVALIDO");
    expect(report.registros[1]?.status_validacao).toBe("BLOQUEADO");
    expect(report.registros[1]?.motivo_bloqueio).toContain("EMAIL_INVALIDO");
    expect(
      report.registros.filter((row) =>
        row.motivo_bloqueio.includes("EMAIL_INVALIDO") &&
        row.status_validacao === "APTO"
      ),
    ).toHaveLength(0);
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
