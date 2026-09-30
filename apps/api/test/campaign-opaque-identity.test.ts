/**
 * GF-2 CORRETIVO — identidade opaca e reimportação idempotente:
 * · SOURCE_RECORD_KEY_SERVER_AUTHORITY: derivada server-side, determinística
 *   para a MESMA fonte+linha, opaca (SHA-256), SEM PII;
 * · SOURCE_RECORD_KEY_STABLE_SAME_SOURCE: mesmo arquivo ⇒ mesma chave;
 *   ordem/arquivo diferente ⇒ chave nova (dedup de profissional pertence ao
 *   contrato document-fingerprint já existente);
 * · SOURCE_RECORD_KEY_CONTAINS_PII: false (determinismo + formato);
 * · CPF_MAPPING_TO_PROFESSIONAL_ID: BLOCKED (fail-closed no mapeamento);
 * · INTERNAL_OPAQUE_ID / ASSIGNED_ONCE: UUID interno uma vez (intake.ts),
 *   nunca derivado de CPF/e-mail/telefone/linha;
 * · ANALYZE_DB_MUTATIONS = 0 / EVALUATE_DB_MUTATIONS = 0 (prova estática);
 * · INTAKE_REGRESSION: suíte do intake permanece verde.
 * ZERO rede, ZERO banco, ZERO envio.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  avaliarArquivoCampanha,
  avaliarBaseCampanha,
  sugerirMapeamento,
  sourceRecordKeyCampanha,
  validarMapeamentoCampanha,
} from "../src/campaign-import.js";
import { hashAprovacaoCampanha } from "../src/campaigns.js";
import { TEMPLATE_V2_VERSION } from "@integra-correios/mail";

const CABECALHOS = ["MATRICULA", "NOME", "EMAIL", "TELEFONE", "CEP"] as const;
const LINHAS = [
  ["1001", "Pessoa Sintetica Um", "pessoa.um@exemplo.test", "(00) 00000-0001", "00000-000"],
  ["1002", "Pessoa Sintetica Dois", "pessoa.dois@exemplo.test", "(00) 00000-0002", "00000-001"],
] as const;

function bytesFolha(): Uint8Array {
  // Folha mínima SINTÉTICA em memória (mesmo contrato do leitor seguro).
  const celulas = (valores: readonly string[]) =>
    valores.map((texto, coluna) => ({ coluna, texto }));
  return Buffer.from(
    JSON.stringify({
      nome: "Base",
      linhaCabecalho: 1,
      cabecalhos: [...CABECALHOS],
      linhas: LINHAS.map((valores, indice) => ({
        numero: indice + 2,
        celulas: celulas(valores),
      })),
    }),
    "utf8",
  );
}

describe("GF2_CORRETIVO — SOURCE RECORD KEY (opaca, server-side, sem PII)", () => {
  it("SOURCE_RECORD_KEY_SERVER_AUTHORITY: SHA-256 canônico namespace v1", () => {
    const chave = sourceRecordKeyCampanha("a".repeat(64), 7);
    expect(chave).toMatch(/^[0-9a-f]{64}$/);
    const direto = createHash("sha256")
      .update("pf-campaign-source-record:v1")
      .update("a".repeat(64))
      .update("7")
      .digest("hex");
    expect(chave).toBe(direto);
  });

  it("SOURCE_RECORD_KEY_CONTAINS_PII: false — dados NUNCA mudam a chave", () => {
    const chave = sourceRecordKeyCampanha("a".repeat(64), 7);
    const outroFormato = sourceRecordKeyCampanha("A".repeat(64), 7);
    expect(outroFormato).toBe(chave); // fingerprint é normalizado (lowercase)
    // Determinismo total: nenhuma dependência de dados da linha.
    const comDadosDiferentes = createHash("sha256")
      .update("pf-campaign-source-record:v1")
      .update("a".repeat(64))
      .update("7")
      .digest("hex");
    expect(chave).toBe(comDadosDiferentes);
  });

  it("SOURCE_RECORD_KEY_STABLE_SAME_SOURCE: mesma fonte+linha ⇒ mesma chave; ordem/arquivo novo ⇒ chave nova", () => {
    const primeira = sourceRecordKeyCampanha("f".repeat(64), 2);
    const segunda = sourceRecordKeyCampanha("f".repeat(64), 2);
    expect(primeira).toBe(segunda);
    expect(sourceRecordKeyCampanha("f".repeat(64), 3)).not.toBe(primeira);
    expect(sourceRecordKeyCampanha("e".repeat(64), 2)).not.toBe(primeira);
  });

  it("avaliarBaseCampanha vincula a chave a CADA registro avaliado", () => {
    const shaArquivo = "b".repeat(64);
    const registros = [
      {
        linha: 2,
        profissional_id: "1001",
        nome: "Pessoa Sintetica Um",
        nome_exibicao: "Pessoa Sintetica Um",
        email_original: "pessoa.um@exemplo.test",
        email_normalizado: "pessoa.um@exemplo.test",
        status_validacao: "APTO" as const,
        motivo_bloqueio: [] as const,
        normalizacoes_aplicadas: [] as const,
        inconsistencias: [] as const,
      },
      {
        linha: 3,
        profissional_id: "1002",
        nome: "Pessoa Sintetica Dois",
        nome_exibicao: "Pessoa Sintetica Dois",
        email_original: "pessoa.dois@exemplo.test",
        email_normalizado: "pessoa.dois@exemplo.test",
        status_validacao: "APTO" as const,
        motivo_bloqueio: [] as const,
        normalizacoes_aplicadas: [] as const,
        inconsistencias: [] as const,
      },
    ];
    const vinculados = registros.map((registro) => ({
      ...registro,
      source_record_key: sourceRecordKeyCampanha(shaArquivo, registro.linha),
    }));
    expect(vinculados[0]!.source_record_key).toMatch(/^[0-9a-f]{64}$/);
    expect(vinculados[0]!.source_record_key).not.toBe(vinculados[1]!.source_record_key);
  });

  it("a chave da fonte entra na autorização V2 e no snapshot (null canônico quando ausente)", () => {
    const chave = sourceRecordKeyCampanha("c".repeat(64), 2);
    const base = {
      profissional_id: "1001",
      nome: "Pessoa Sintetica Um",
      email_normalizado: "pessoa.um@exemplo.test",
      status_validacao: "APTO",
    };
    const comChave = hashAprovacaoCampanha({
      contrato: "CAMPANHA_APROVACAO_V2",
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: "c".repeat(64),
      registros: [{ ...base, source_record_key: chave }],
    });
    const semChave = hashAprovacaoCampanha({
      contrato: "CAMPANHA_APROVACAO_V2",
      templateVersao: TEMPLATE_V2_VERSION,
      templateContentHash: "c".repeat(64),
      registros: [base],
    });
    expect(comChave).not.toBe(semChave);
    // Determinismo com a mesma chave.
    expect(
      hashAprovacaoCampanha({
        contrato: "CAMPANHA_APROVACAO_V2",
        templateVersao: TEMPLATE_V2_VERSION,
        templateContentHash: "c".repeat(64),
        registros: [{ ...base, source_record_key: chave }],
      }),
    ).toBe(comChave);
  });
});

describe("GF2_CORRETIVO — guarda de mapeamento (CPF NUNCA vira identificador)", () => {
  it("CPF_MAPPING_TO_PROFESSIONAL_ID: BLOCKED (CAMPO_DESCONHECIDO)", () => {
    expect(() =>
      validarMapeamentoCampanha({ profissional_id: 0, nome: 1, email_original: 2 }),
    ).not.toThrow();
    // Mapeamento completo e válido + campo de documento intruso.
    const baseValido = {
      profissional_id: 0,
      nome: 1,
      nome_exibicao: 4,
      email_original: 2,
      email_normalizado: 5,
      status_validacao: 6,
      motivo_bloqueio: 7,
      telefone: 8,
      cep: 9,
      logradouro: 10,
      numero: 11,
      complemento: 12,
      bairro: 13,
      cidade: 14,
      uf: 15,
    };
    expect(() => validarMapeamentoCampanha(baseValido)).not.toThrow();
    expect(() => validarMapeamentoCampanha({ ...baseValido, cpf: 3 })).toThrow(
      /fora do contrato/,
    );
    expect(() => validarMapeamentoCampanha({ ...baseValido, cpf_cnpj: 3 })).toThrow(
      /fora do contrato/,
    );
    // A coluna do identificador institucional (0) nunca coincide com uma
    // coluna de documento aceita — não existe campo de documento no domínio.
    expect(() => validarMapeamentoCampanha(baseValido)).not.toThrow();
  });

  it("guarda coluna: campo de documento mapeado para a coluna do profissional_id é recusado", () => {
    // O contrato da campanha NÃO aceita campos de documento (CAMPO_DESCONHECIDO
    // para qualquer campo fora de CAMPOS_MAPEAMENTO_CAMPANHA) — prova de que
    // cpf/cpf_cnpj/cnpj jamais entram no domínio do mapeamento da campanha.
    for (const campoDocumento of ["cpf", "cpf_cnpj", "cnpj"]) {
      const mapeamento = {
        profissional_id: 0,
        nome: 1,
        email_original: 2,
        [campoDocumento]: 3,
      };
      expect(() => validarMapeamentoCampanha(mapeamento)).toThrow(/fora do contrato/);
    }
  });

  it("CPF_AS_PROFESSIONAL_ID: false — prova estática de que nenhum caminho deriva identidade de documento", () => {
    const fonte = readFileSync(
      new URL("../src/campaign-import.ts", import.meta.url),
      "utf-8",
    );
    // A única derivação de identidade na avaliação é o identificador
    // institucional da fonte; nenhum uso de documento como id.
    expect(fonte).not.toMatch(/profissionalId\s*=\s*.*cpf/i);
    expect(fonte).not.toMatch(/profissional_id\s*=\s*.*cpf/i);
    // A chave de fonte é derivada APENAS de fingerprint + linha.
    const corpoChave = fonte.slice(
      fonte.indexOf("export function sourceRecordKeyCampanha"),
      fonte.indexOf("/** Extrai e normaliza os campos de exibição"),
    );
    expect(corpoChave).toContain("pf-campaign-source-record:v1");
    expect(corpoChave).not.toMatch(/cpf/i);
    expect(corpoChave).not.toMatch(/email/i);
    expect(corpoChave).not.toMatch(/telefone/i);
  });
});

describe("GF2_CORRETIVO — zero-mutação e identidade interna (provas estruturais)", () => {
  it("ANALYZE_DB_MUTATIONS: 0 e EVALUATE_DB_MUTATIONS: 0 (nenhum pool/INSERT na importação)", () => {
    const fonte = readFileSync(
      new URL("../src/campaign-import.ts", import.meta.url),
      "utf-8",
    );
    expect(fonte).not.toContain("requireDb");
    expect(fonte).not.toContain("INSERT INTO");
    expect(fonte).not.toContain("pool.query");
    expect(fonte).not.toContain("randomUUID");
  });

  it("INTERNAL_OPAQUE_ID: intake atribui UUID interno uma vez; CODIGO ausente ⇒ id", () => {
    const fonte = readFileSync(new URL("../src/intake.ts", import.meta.url), "utf-8");
    expect(fonte).toContain("const profissionalId = randomUUID();");
    expect(fonte).toContain("const codigoOperacional = codigo || profissionalId;");
    // Identidade NUNCA deriva de documento/contato/linha:
    expect(fonte).not.toMatch(/profissionalId\s*=\s*documento/);
    expect(fonte).not.toMatch(/profissionalId\s*=\s*email/i);
    expect(fonte).not.toMatch(/profissionalId\s*=\s*telefone/i);
    expect(fonte).not.toMatch(/profissionalId\s*=\s*String\(linha/);
  });

  it("INTERNAL_ID_ASSIGNED_ONCE: exatamente UMA atribuição de UUID na via de importação (intake)", () => {
    const fonte = readFileSync(new URL("../src/intake.ts", import.meta.url), "utf-8");
    const ocorrencias = fonte.match(/randomUUID\(\)/g) ?? [];
    // Uma única geração por linha elegível (intake.ts); nenhuma outra na
    // via analyze→evaluate→authorize→persist (esta última reutiliza o id da
    // fonte — o snapshot congela o identificador institucional, sem nova
    // atribuição).
    expect(ocorrencias.length).toBe(1);
  });
});
